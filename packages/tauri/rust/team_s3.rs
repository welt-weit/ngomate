//! A team's notes and tasks in an S3-compatible bucket: AWS, R2, B2, Spaces, Wasabi, Hetzner, MinIO,
//! Garage. Requests are signed here (AWS Signature Version 4), and a write names the ETag it replaces,
//! so a change someone else made is refused rather than overwritten, where the provider supports it.

use crate::error::{Error, Result};
use crate::store::check_name;
use crate::team::{Area, Entry, Read, Written, TEAM_FILE};
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct S3 {
    endpoint: reqwest::Url,
    region: String,
    bucket: String,
    access_key_id: String,
    secret: String,
    client: reqwest::Client,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("any key length works");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// RFC 3986 encoding as Signature Version 4 wants it; `/` kept only in paths.
fn encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Days since 1970 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since 1970 from a listing's `2026-11-23T10:00:00.000Z`. None when it is not that shape.
fn listed_time(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let days = days_from_civil(number(0..4)?, number(5..7)?, number(8..10)?);
    let seconds = days * 86_400 + number(11..13)? * 3_600 + number(14..16)? * 60 + number(17..19)?;
    u64::try_from(seconds).ok().map(|seconds| seconds * 1_000)
}

/// `20130524T000000Z` from seconds since 1970, without a date library.
fn amz_date(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// One request as Signature Version 4 sees it. Every header given is signed.
struct Signed<'a> {
    method: &'a str,
    path: &'a str,
    query: &'a [(String, String)],
    headers: &'a [(String, String)],
    payload_hash: &'a str,
    date: &'a str,
}

/// The `Authorization` header for one request.
fn authorization(request: &Signed, region: &str, access_key_id: &str, secret: &str) -> String {
    let Signed { method, path, query, headers, payload_hash, date } = *request;
    let mut query: Vec<(String, String)> =
        query.iter().map(|(name, value)| (encode(name, false), encode(value, false))).collect();
    query.sort();
    let canonical_query = query.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
    let mut headers: Vec<(String, String)> = headers.iter().map(|(name, value)| (name.to_lowercase(), value.trim().to_string())).collect();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();
    let signed_headers = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request =
        format!("{method}\n{}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}", encode(path, true));
    let day = &date[..8];
    let scope = format!("{day}/{region}/s3/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let key = hmac(&hmac(&hmac(&hmac(format!("AWS4{secret}").as_bytes(), day), region), "s3"), "aws4_request");
    let signature = hex::encode(hmac(&key, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}")
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The text of each `<tag>` inside `block`. Enough XML for a bucket listing, which has no nesting there.
fn tag<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&format!("</{name}>"))? + start;
    Some(&block[start..end])
}

fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut found = vec![];
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        found.push(&after[..end]);
        rest = &after[end + close.len()..];
    }
    found
}

/// An ETag as the version, without its quotes, so it is the same however a provider quotes it.
fn etag(response: &reqwest::Response) -> Option<String> {
    response.headers().get("etag")?.to_str().ok().map(|value| value.trim_matches('"').to_string())
}

/// In words a person can act on, with the provider's own reason when it gave one.
async fn refused(response: reqwest::Response) -> Error {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let reason = tag(&body, "Message").map(unescape).filter(|text| !text.is_empty());
    let said = |text: &str| match &reason {
        Some(reason) => format!("{text} The storage said: {}", reason.chars().take(200).collect::<String>()),
        None => text.to_string(),
    };
    Error::msg(match status {
        401 | 403 => said("The bucket refused the key (403). Check the access key, its secret and that it may use this bucket."),
        404 => said("There is no such bucket at that address (404)."),
        code => said(&format!("The storage answered {code}.")),
    })
}

impl S3 {
    pub fn new(endpoint: &str, region: &str, bucket: &str, access_key_id: &str, secret: String) -> Result<S3> {
        let endpoint = reqwest::Url::parse(endpoint.trim_end_matches('/')).map_err(|_| Error::msg("Not a valid address"))?;
        Ok(S3 {
            endpoint,
            region: if region.trim().is_empty() { "us-east-1".to_string() } else { region.trim().to_string() },
            bucket: bucket.trim().to_string(),
            access_key_id: access_key_id.trim().to_string(),
            secret,
            client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?,
        })
    }

    /// Path-style addresses (`endpoint/bucket/key`), which every provider here understands.
    async fn send(
        &self,
        method: Method,
        key: Option<&str>,
        query: &[(String, String)],
        extra: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<reqwest::Response> {
        let base_path = self.endpoint.path().trim_end_matches('/');
        let path = match key {
            Some(key) => format!("{base_path}/{}/{key}", self.bucket),
            None => format!("{base_path}/{}", self.bucket),
        };
        let host = match self.endpoint.port() {
            Some(port) => format!("{}:{port}", self.endpoint.host_str().unwrap_or_default()),
            None => self.endpoint.host_str().unwrap_or_default().to_string(),
        };
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let date = amz_date(seconds);
        let payload_hash = sha256_hex(&body);
        let mut headers = vec![
            ("host".to_string(), host),
            ("x-amz-content-sha256".to_string(), payload_hash.clone()),
            ("x-amz-date".to_string(), date.clone()),
        ];
        headers.extend(extra.iter().map(|(name, value)| (name.to_string(), value.clone())));
        let signed = Signed {
            method: method.as_str(),
            path: &path,
            query,
            headers: &headers,
            payload_hash: &payload_hash,
            date: &date,
        };
        let auth = authorization(&signed, &self.region, &self.access_key_id, &self.secret);
        let mut url = self.endpoint.clone();
        url.set_path(&encode(&path, true));
        if !query.is_empty() {
            url.set_query(Some(
                &query.iter().map(|(name, value)| format!("{}={}", encode(name, false), encode(value, false))).collect::<Vec<_>>().join("&"),
            ));
        }
        let mut request = self.client.request(method, url).header("authorization", auth);
        for (name, value) in headers.iter().filter(|(name, _)| name != "host") {
            request = request.header(name.as_str(), value.as_str());
        }
        Ok(request.body(body).send().await?)
    }

    fn key(area: Area, name: &str) -> Result<String> {
        check_name(name)?;
        Ok(format!("{}/{name}.md", area.folder()))
    }

    pub async fn list(&self, area: Area) -> Result<Vec<Entry>> {
        let prefix = format!("{}/", area.folder());
        let mut entries = vec![];
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![("list-type".to_string(), "2".to_string()), ("prefix".to_string(), prefix.clone())];
            if let Some(token) = &token {
                query.push(("continuation-token".to_string(), token.clone()));
            }
            let response = self.send(Method::GET, None, &query, &[], vec![]).await?;
            if !response.status().is_success() {
                return Err(refused(response).await);
            }
            let xml = response.text().await?;
            for block in blocks(&xml, "Contents") {
                let Some(key) = tag(block, "Key").map(unescape) else { continue };
                let Some(name) = key.strip_prefix(&prefix).and_then(|rest| rest.strip_suffix(".md")) else { continue };
                if check_name(name).is_err() {
                    continue;
                }
                entries.push(Entry {
                    name: name.to_string(),
                    version: tag(block, "ETag").map(|value| unescape(value).trim_matches('"').to_string()).unwrap_or_default(),
                    updated_at: tag(block, "LastModified").and_then(listed_time),
                    bytes: tag(block, "Size").and_then(|size| size.parse().ok()).unwrap_or(0),
                });
            }
            token = match tag(&xml, "IsTruncated") {
                Some("true") => tag(&xml, "NextContinuationToken").map(unescape),
                _ => None,
            };
            if token.is_none() {
                return Ok(entries);
            }
        }
    }

    async fn get(&self, key: &str) -> Result<Option<Read>> {
        let response = self.send(Method::GET, Some(key), &[], &[], vec![]).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refused(response).await);
        }
        let version = etag(&response).unwrap_or_default();
        let bytes = response.bytes().await?;
        Ok(Some(Read { text: String::from_utf8_lossy(&bytes).into_owned(), version }))
    }

    /// Only over the expected ETag, or only where nothing is, so two people cannot overwrite each other.
    async fn put(&self, key: &str, text: &str, expected: Option<&str>) -> Result<Written> {
        let condition = match expected {
            Some(version) => ("if-match", format!("\"{version}\"")),
            None => ("if-none-match", "*".to_string()),
        };
        let response = self
            .send(Method::PUT, Some(key), &[], &[condition, ("content-type", "text/markdown; charset=utf-8".to_string())], text.as_bytes().to_vec())
            .await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT => Ok(Written { version: None, conflict: true }),
            status if status.is_success() => Ok(Written { version: etag(&response), conflict: false }),
            _ => Err(refused(response).await),
        }
    }

    pub async fn read(&self, area: Area, name: &str) -> Result<Option<Read>> {
        self.get(&S3::key(area, name)?).await
    }

    pub async fn write(&self, area: Area, name: &str, text: &str, expected: Option<&str>) -> Result<Written> {
        self.put(&S3::key(area, name)?, text, expected).await
    }

    /// Checked against the version first, since not every provider honours a condition on delete.
    pub async fn remove(&self, area: Area, name: &str, expected: Option<&str>) -> Result<Written> {
        let key = S3::key(area, name)?;
        let Some(current) = self.get(&key).await? else { return Ok(Written { version: None, conflict: false }) };
        if Some(current.version.as_str()) != expected {
            return Ok(Written { version: None, conflict: true });
        }
        let response = self.send(Method::DELETE, Some(&key), &[], &[], vec![]).await?;
        if !response.status().is_success() {
            return Err(refused(response).await);
        }
        Ok(Written { version: None, conflict: false })
    }

    pub async fn refuses_overwrites(&self) -> Result<bool> {
        const PROBE: &str = "ngomate-probe.txt";
        self.put(PROBE, "probe", None).await?;
        let refuses = self.put(PROBE, "probe", None).await?.conflict;
        let gone = self.send(Method::DELETE, Some(PROBE), &[], &[], vec![]).await?;
        if !gone.status().is_success() {
            return Err(refused(gone).await);
        }
        Ok(refuses)
    }

    pub async fn read_team_file(&self) -> Result<Option<Read>> {
        self.get(TEAM_FILE).await
    }

    pub async fn write_team_file(&self, text: &str, expected: Option<&str>) -> Result<Written> {
        self.put(TEAM_FILE, text, expected).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_as_the_published_example_does() {
        // The GET Object example in AWS's Signature Version 4 documentation for S3.
        let empty = sha256_hex(b"");
        let headers = [
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("range".to_string(), "bytes=0-9".to_string()),
            ("x-amz-content-sha256".to_string(), empty.clone()),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
        ];
        let request = Signed {
            method: "GET",
            path: "/test.txt",
            query: &[],
            headers: &headers,
            payload_hash: &empty,
            date: "20130524T000000Z",
        };
        let auth = authorization(&request, "us-east-1", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
        assert!(auth.ends_with("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"), "{auth}");
    }

    #[test]
    fn writes_the_date_as_the_signature_wants_it_and_reads_a_listed_one() {
        assert_eq!(amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(amz_date(951_782_400), "20000229T000000Z");
        assert_eq!(listed_time("2013-05-24T00:00:00.000Z"), Some(1_369_353_600_000));
        assert_eq!(listed_time("yesterday"), None);
    }

    #[test]
    fn reads_a_bucket_listing() {
        let xml = r#"<ListBucketResult><IsTruncated>false</IsTruncated>
            <Contents><Key>notes/plan.md</Key><ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>
            <Contents><Key>notes/A &amp; B.md</Key><ETag>"def"</ETag><Size>3</Size></Contents>
            </ListBucketResult>"#;
        let found: Vec<_> = blocks(xml, "Contents").into_iter().map(|block| unescape(tag(block, "Key").unwrap())).collect();
        assert_eq!(found, ["notes/plan.md", "notes/A & B.md"]);
    }

    /// Against a real S3 server such as MinIO in Docker. Skipped unless NGOMATE_S3_TEST holds
    /// `endpoint bucket key secret`.
    #[tokio::test]
    async fn keeps_team_notes_in_a_real_bucket() {
        let Ok(setting) = std::env::var("NGOMATE_S3_TEST") else { return };
        let parts: Vec<&str> = setting.split_whitespace().collect();
        let [endpoint, bucket, key, secret] = parts[..] else { panic!("NGOMATE_S3_TEST needs four values") };
        let s3 = S3::new(endpoint, "us-east-1", bucket, key, secret.to_string()).unwrap();
        // Made here, through the same signing, so the test needs nothing but the server.
        let made = s3.send(Method::PUT, None, &[], &[], vec![]).await.unwrap().status();
        assert!(made.is_success() || made == StatusCode::CONFLICT, "{made}");
        assert!(s3.refuses_overwrites().await.unwrap());
        assert!(s3.get("ngomate-probe.txt").await.unwrap().is_none(), "the test file was left behind");
        let name = format!("A & B test {}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());

        let first = s3.write(Area::Notes, &name, "Meet on Monday.", None).await.unwrap();
        assert!(!first.conflict);
        let version = first.version.clone().unwrap();
        // A second "new" note under the same name must not replace the first.
        assert!(s3.write(Area::Notes, &name, "Other", None).await.unwrap().conflict);
        let read = s3.read(Area::Notes, &name).await.unwrap().unwrap();
        assert_eq!((read.text.as_str(), read.version.as_str()), ("Meet on Monday.", version.as_str()));
        assert!(s3.list(Area::Notes).await.unwrap().iter().any(|entry| entry.name == name && entry.version == version));

        let second = s3.write(Area::Notes, &name, "Meet on Tuesday.", Some(&version)).await.unwrap();
        assert!(!second.conflict);
        // Writing over the old version again is someone else's change being overwritten: refused.
        assert!(s3.write(Area::Notes, &name, "Stale", Some(&version)).await.unwrap().conflict);
        assert!(s3.remove(Area::Notes, &name, Some(&version)).await.unwrap().conflict);
        assert!(!s3.remove(Area::Notes, &name, second.version.as_deref()).await.unwrap().conflict);
        assert!(s3.read(Area::Notes, &name).await.unwrap().is_none());

        let wrong = S3::new(endpoint, "us-east-1", bucket, key, "wrong".into()).unwrap();
        assert!(wrong.list(Area::Notes).await.unwrap_err().to_string().contains("403"));
    }
}
