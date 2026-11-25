//! A team's notes, tasks and jobs in a folder on a WebDAV server: Nextcloud, ownCloud, a NAS. A write names
//! the ETag it replaces (`If-Match`), or `If-None-Match: *` for a new note, so a change someone else
//! made is refused rather than overwritten. Nextcloud's own sign-in (Login Flow v2) gives the app its
//! own password, which the person can revoke in Nextcloud.

use crate::error::{Error, Result};
use crate::store::check_name;
use crate::team::{allowed_address, Area, Entry, Read, Written, TEAM_FILE};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use std::time::Duration;

pub struct Dav {
    /// The team folder, ending in `/`.
    base: reqwest::Url,
    user: String,
    password: String,
    client: reqwest::Client,
}

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).expect("a valid method name")
}

/// One path segment, encoded.
fn segment(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[at + 1..at + 3], 16) {
                out.push(byte);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The contents of every element with this local name, whatever namespace prefix the server uses.
fn elements<'a>(xml: &'a str, local: &str) -> Vec<&'a str> {
    let mut found = vec![];
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..end];
        let name = tag.split_whitespace().next().unwrap_or("");
        let bare = name.rsplit(':').next().unwrap_or(name);
        if bare != local || name.starts_with('/') || tag.ends_with('/') {
            continue;
        }
        let body = &rest[end + 1..];
        let close = format!("</{name}>");
        let Some(stop) = body.find(&close) else { break };
        found.push(&body[..stop]);
        rest = &body[stop + close.len()..];
    }
    found
}

/// Whether an element with this local name is there at all, empty (`<d:collection/>`) or not.
fn has_element(xml: &str, local: &str) -> bool {
    xml.split('<').skip(1).any(|tag| {
        let name = tag.split(|c: char| c.is_whitespace() || c == '>' || c == '/').next().unwrap_or("");
        !tag.starts_with('/') && name.rsplit(':').next() == Some(local)
    })
}

fn first<'a>(xml: &'a str, local: &str) -> Option<&'a str> {
    elements(xml, local).into_iter().next()
}

/// An ETag as the version, without the quotes a server puts around it.
fn clean_etag(raw: &str) -> String {
    raw.trim().trim_matches('"').to_string()
}

fn etag(response: &reqwest::Response) -> Option<String> {
    response.headers().get("etag")?.to_str().ok().map(clean_etag)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Milliseconds since 1970 from `Sun, 23 Nov 2026 10:00:00 GMT`. None when it is not that shape.
fn http_time(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let [_, day, month, year, time, _] = parts[..] else { return None };
    let month = MONTHS.iter().position(|name| *name == month)? as i64 + 1;
    let (day, year): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let clock: Vec<i64> = time.split(':').filter_map(|part| part.parse().ok()).collect();
    let [hours, minutes, seconds] = clock[..] else { return None };
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let yoe = shifted - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(days * 86_400 + hours * 3_600 + minutes * 60 + seconds).ok().map(|s| s * 1_000)
}

fn refused(status: StatusCode) -> Error {
    Error::msg(match status.as_u16() {
        401 => "The server refused the user name or password (401). For Nextcloud, sign in again to get a new app password.".to_string(),
        403 => "The server does not let this account use that folder (403).".to_string(),
        404 => "There is no folder at that address (404).".to_string(),
        409 => "A folder on the way to that address does not exist (409). Check the folder's address.".to_string(),
        code => format!("The server answered {code}."),
    })
}

const PROPFIND: &str = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>"#;

impl Dav {
    pub fn new(url: &str, user: &str, password: String) -> Result<Dav> {
        let mut base = reqwest::Url::parse(url.trim()).map_err(|_| Error::msg("Not a valid address"))?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Dav {
            base,
            user: user.trim().to_string(),
            password,
            client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?,
        })
    }

    fn url(&self, parts: &[&str]) -> Result<reqwest::Url> {
        let path: Vec<String> = parts.iter().map(|part| segment(part)).collect();
        self.base.join(&path.join("/")).map_err(|_| Error::msg("Not a valid address"))
    }

    fn request(&self, method: Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        self.client.request(method, url).basic_auth(&self.user, Some(&self.password))
    }

    fn note_url(area: Area, name: &str, dav: &Dav) -> Result<reqwest::Url> {
        check_name(name)?;
        dav.url(&[area.folder(), &area.file_name(name)])
    }

    pub async fn list(&self, area: Area) -> Result<Vec<Entry>> {
        let folder = self.url(&[area.folder(), ""])?;
        let response = self
            .request(method("PROPFIND"), folder.clone())
            .header("depth", "1")
            .header("content-type", "application/xml; charset=utf-8")
            .body(PROPFIND)
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        if !response.status().is_success() {
            return Err(refused(response.status()));
        }
        let xml = response.text().await?;
        let mut entries = vec![];
        for item in elements(&xml, "response") {
            let Some(href) = first(item, "href") else { continue };
            let path = decode(&unescape(href.trim()));
            let Some(file) = path.trim_end_matches('/').rsplit('/').next() else { continue };
            let Some(name) = file.strip_suffix(&format!(".{}", area.extension())) else { continue };
            if check_name(name).is_err() || has_element(item, "collection") {
                continue;
            }
            entries.push(Entry {
                name: name.to_string(),
                version: first(item, "getetag").map(|value| clean_etag(&unescape(value))).unwrap_or_default(),
                updated_at: first(item, "getlastmodified").and_then(|value| http_time(value.trim())),
                bytes: first(item, "getcontentlength").and_then(|value| value.trim().parse().ok()).unwrap_or(0),
            });
        }
        Ok(entries)
    }

    async fn get(&self, url: reqwest::Url) -> Result<Option<Read>> {
        let response = self.request(Method::GET, url).send().await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refused(response.status()));
        }
        let version = etag(&response).unwrap_or_default();
        let bytes = response.bytes().await?;
        Ok(Some(Read { text: String::from_utf8_lossy(&bytes).into_owned(), version }))
    }

    async fn put(&self, url: reqwest::Url, text: &str, expected: Option<&str>, folder: Option<Area>) -> Result<Written> {
        let send = || {
            let request = self
                .request(Method::PUT, url.clone())
                .header("content-type", folder.map_or("text/markdown; charset=utf-8", Area::content_type))
                .body(text.to_string());
            match expected {
                Some(version) => request.header("if-match", format!("\"{version}\"")),
                None => request.header("if-none-match", "*"),
            }
        };
        let mut response = send().send().await?;
        // The first note in an area: make its folder, then try once more.
        if let (Some(area), StatusCode::NOT_FOUND | StatusCode::CONFLICT) = (folder, response.status()) {
            let made = self.request(method("MKCOL"), self.url(&[area.folder(), ""])?).send().await?;
            if made.status().is_success() || made.status() == StatusCode::METHOD_NOT_ALLOWED {
                response = send().send().await?;
            }
        }
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(Written { version: None, conflict: true }),
            status if status.is_success() => {
                let version = match etag(&response) {
                    Some(version) => Some(version),
                    // Not every server answers a PUT with the new ETag; ask for it.
                    None => self.get(url).await?.map(|read| read.version),
                };
                Ok(Written { version, conflict: false })
            }
            status => Err(refused(status)),
        }
    }

    pub async fn read(&self, area: Area, name: &str) -> Result<Option<Read>> {
        self.get(Dav::note_url(area, name, self)?).await
    }

    pub async fn write(&self, area: Area, name: &str, text: &str, expected: Option<&str>) -> Result<Written> {
        self.put(Dav::note_url(area, name, self)?, text, expected, Some(area)).await
    }

    pub async fn remove(&self, area: Area, name: &str, expected: Option<&str>) -> Result<Written> {
        let url = Dav::note_url(area, name, self)?;
        let mut request = self.request(Method::DELETE, url);
        if let Some(version) = expected {
            request = request.header("if-match", format!("\"{version}\""));
        }
        let response = request.send().await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(Written { version: None, conflict: true }),
            StatusCode::NOT_FOUND => Ok(Written { version: None, conflict: false }),
            status if status.is_success() => Ok(Written { version: None, conflict: false }),
            status => Err(refused(status)),
        }
    }

    /// Also makes the team folder, which a team being set up may not have yet.
    pub async fn refuses_overwrites(&self) -> Result<bool> {
        let made = self.request(method("MKCOL"), self.base.clone()).send().await?;
        if !(made.status().is_success() || made.status() == StatusCode::METHOD_NOT_ALLOWED) {
            return Err(refused(made.status()));
        }
        let probe = self.url(&["ngomate-probe.txt"])?;
        self.put(probe.clone(), "probe", None, None).await?;
        let refuses = self.put(probe.clone(), "probe", None, None).await?.conflict;
        let gone = self.request(Method::DELETE, probe).send().await?;
        if !(gone.status().is_success() || gone.status() == StatusCode::NOT_FOUND) {
            return Err(refused(gone.status()));
        }
        Ok(refuses)
    }

    pub async fn read_team_file(&self) -> Result<Option<Read>> {
        self.get(self.url(&[TEAM_FILE])?).await
    }

    /// Also makes the team folder itself, for a team being set up in a folder that is not there yet.
    pub async fn write_team_file(&self, text: &str, expected: Option<&str>) -> Result<Written> {
        if expected.is_none() {
            let made = self.request(method("MKCOL"), self.base.clone()).send().await?;
            if !(made.status().is_success() || made.status() == StatusCode::METHOD_NOT_ALLOWED) {
                return Err(refused(made.status()));
            }
        }
        self.put(self.url(&[TEAM_FILE])?, text, expected, None).await
    }
}

/// Where the person signs in, and where the app then asks for the result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub login_url: String,
    pub poll_url: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginDone {
    pub server: String,
    pub login_name: String,
    pub app_password: String,
}

/// Starts Nextcloud's Login Flow v2: the person signs in in their own browser.
pub async fn nextcloud_login_start(server: &str) -> Result<LoginStart> {
    if !allowed_address(server) {
        return Err(Error::msg("The Nextcloud address needs https."));
    }
    let url = format!("{}/index.php/login/v2", server.trim().trim_end_matches('/'));
    let response = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?.post(url).send().await?;
    if !response.status().is_success() {
        return Err(Error::msg(format!("This does not look like a Nextcloud server ({}).", response.status().as_u16())));
    }
    let data: serde_json::Value = serde_json::from_str(&response.text().await?).map_err(|_| Error::msg("This does not look like a Nextcloud server."))?;
    let text = |pointer: &str| data.pointer(pointer).and_then(|value| value.as_str()).map(str::to_string);
    let (Some(login_url), Some(poll_url), Some(token)) = (text("/login"), text("/poll/endpoint"), text("/poll/token")) else {
        return Err(Error::msg("This does not look like a Nextcloud server."));
    };
    // Both come from the server; only addresses of the kind the app would accept anyway are followed.
    if !allowed_address(&login_url) || !allowed_address(&poll_url) {
        return Err(Error::msg("The server sent a sign-in address the app will not follow."));
    }
    Ok(LoginStart { login_url, poll_url, token })
}

/// Waits for the person to finish signing in, up to `limit`. Nextcloud answers 404 until then.
pub async fn nextcloud_login_wait(poll_url: &str, token: &str, limit: Duration) -> Result<LoginDone> {
    if !allowed_address(poll_url) {
        return Err(Error::msg("The server sent a sign-in address the app will not follow."));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?;
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let response = client.post(poll_url).form(&[("token", token)]).send().await?;
        if response.status().is_success() {
            let data: serde_json::Value = serde_json::from_str(&response.text().await?).map_err(|_| Error::msg("Nextcloud's answer could not be read."))?;
            let text = |key: &str| data.get(key).and_then(|value| value.as_str()).map(str::to_string);
            let (Some(server), Some(login_name), Some(app_password)) = (text("server"), text("loginName"), text("appPassword")) else {
                return Err(Error::msg("Nextcloud's answer could not be read."));
            };
            return Ok(LoginDone { server, login_name, app_password });
        }
        if response.status() != StatusCode::NOT_FOUND {
            return Err(Error::msg(format!("Signing in to Nextcloud failed ({}).", response.status().as_u16())));
        }
        if tokio::time::Instant::now() > deadline {
            return Err(Error::msg("Signing in took too long. Start again."));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_multistatus_whatever_the_prefix() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/team/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
          <d:response><d:href>/dav/team/notes/A%20%26%20B.md</d:href><d:propstat><d:prop>
            <d:getetag>&quot;abc&quot;</d:getetag><d:getcontentlength>12</d:getcontentlength>
            <d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>
          </d:multistatus>"#;
        let items = elements(xml, "response");
        assert_eq!(items.len(), 2);
        assert!(has_element(items[0], "collection"));
        assert!(!has_element(items[1], "collection"));
        assert_eq!(decode(first(items[1], "href").unwrap()), "/dav/team/notes/A & B.md");
        assert_eq!(clean_etag(&unescape(first(items[1], "getetag").unwrap())), "abc");
        assert_eq!(http_time("Fri, 24 May 2013 00:00:00 GMT"), Some(1_369_353_600_000));
        let plain = "<multistatus><response><href>/x.md</href></response></multistatus>";
        assert_eq!(elements(plain, "response").len(), 1);
    }

    /// Nextcloud's sign-in against a real server: it starts, and waits while nobody has signed in.
    /// Skipped unless NGOMATE_NEXTCLOUD_TEST holds the server's address.
    #[tokio::test]
    async fn starts_nextclouds_sign_in_and_waits_for_the_person() {
        let Ok(server) = std::env::var("NGOMATE_NEXTCLOUD_TEST") else { return };
        let started = nextcloud_login_start(&server).await.unwrap();
        assert!(started.login_url.contains("/login/v2/flow/"), "{}", started.login_url);
        let waited = nextcloud_login_wait(&started.poll_url, &started.token, Duration::ZERO).await;
        assert!(waited.err().unwrap().to_string().contains("took too long"));
        assert!(nextcloud_login_start("http://example.org").await.is_err());
    }

    /// Against a real WebDAV server, such as Nextcloud in Docker. Skipped unless NGOMATE_DAV_TEST
    /// holds `folder-url user password`.
    #[tokio::test]
    async fn keeps_team_notes_on_a_real_server() {
        let Ok(setting) = std::env::var("NGOMATE_DAV_TEST") else { return };
        let parts: Vec<&str> = setting.split_whitespace().collect();
        let [url, user, password] = parts[..] else { panic!("NGOMATE_DAV_TEST needs three values") };
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dav = Dav::new(&format!("{url}/team-{nanos}"), user, password.to_string()).unwrap();

        assert!(dav.refuses_overwrites().await.unwrap());
        assert!(dav.read_team_file().await.unwrap().is_none());
        assert!(!dav.write_team_file("{}", None).await.unwrap().conflict);
        assert!(dav.write_team_file("{}", None).await.unwrap().conflict);
        assert!(dav.list(Area::Notes).await.unwrap().is_empty());

        let name = "A & B plan";
        let first_write = dav.write(Area::Notes, name, "Meet on Monday.", None).await.unwrap();
        let version = first_write.version.clone().unwrap();
        assert!(dav.write(Area::Notes, name, "Other", None).await.unwrap().conflict);
        let read = dav.read(Area::Notes, name).await.unwrap().unwrap();
        assert_eq!((read.text.as_str(), read.version.as_str()), ("Meet on Monday.", version.as_str()));
        let listed = dav.list(Area::Notes).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].name.as_str(), listed[0].version.as_str()), (name, version.as_str()));

        let second = dav.write(Area::Notes, name, "Meet on Tuesday.", Some(&version)).await.unwrap();
        assert!(!second.conflict);
        assert!(dav.write(Area::Notes, name, "Stale", Some(&version)).await.unwrap().conflict);
        assert!(dav.remove(Area::Notes, name, Some(&version)).await.unwrap().conflict);
        assert!(!dav.remove(Area::Notes, name, second.version.as_deref()).await.unwrap().conflict);
        assert!(dav.read(Area::Notes, name).await.unwrap().is_none());

        // A team job's state, as JSON in its own folder: only one of two claims over one version lands.
        let state = dav.write(Area::JobStates, "weekly", "{}", None).await.unwrap();
        let read = state.version.as_deref();
        // Some servers, Nextcloud among them, keep a file's ETag for two writes within one second, so this
        // waits; the app reads its claim back before running for the same reason.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        assert!(!dav.write(Area::JobStates, "weekly", r#"{"claim":"Amina"}"#, read).await.unwrap().conflict);
        assert!(dav.write(Area::JobStates, "weekly", r#"{"claim":"Jonas"}"#, read).await.unwrap().conflict);
        let states = dav.list(Area::JobStates).await.unwrap();
        assert_eq!(states.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), ["weekly"]);
        assert!(dav.list(Area::Jobs).await.unwrap().is_empty());

        let wrong = Dav::new(url, user, "wrong".into()).unwrap();
        assert!(wrong.list(Area::Notes).await.unwrap_err().to_string().contains("401"));
    }
}
