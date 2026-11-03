/// Models the app offers, pinned to a revision and checksum, so what passed testing is what downloads.
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub license: &'static str,
    pub url: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub min_ram_gb: u64,
}

pub const MODELS: &[Model] = &[
    Model {
        id: "qwen3-8b-q4",
        name: "Qwen 3 8B",
        vendor: "Alibaba",
        license: "Apache-2.0",
        url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf",
        file: "Qwen3-8B-Q4_K_M.gguf",
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        size_bytes: 5027783488,
        min_ram_gb: 8,
    },
    Model {
        id: "ministral-3-8b-q4",
        name: "Ministral 3 8B",
        vendor: "Mistral AI",
        license: "Apache-2.0",
        url: "https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF/resolve/0102285ad796bd99af90f58de616092e5630e970/Ministral-3-8B-Instruct-2512-Q4_K_M.gguf",
        file: "Ministral-3-8B-Instruct-2512-Q4_K_M.gguf",
        sha256: "33e7a72cf5e6e2cfc2f2847075acc013d68bba023e35310cef86b5cf8fdca761",
        size_bytes: 5198911904,
        min_ram_gb: 8,
    },
    Model {
        id: "granite-4.2-8b-q4",
        name: "Granite 4.2 8B",
        vendor: "IBM",
        license: "Apache-2.0",
        url: "https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF/resolve/93f3f6a8938ee922b784cf4e5b4203cd3428df8f/granite-4.2-8b-Q4_K_M.gguf",
        file: "granite-4.2-8b-Q4_K_M.gguf",
        sha256: "16a9369d0805f80b7377d25d87f937a90c05dc04ad79173a52001e42c9aab311",
        size_bytes: 5347917952,
        min_ram_gb: 8,
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}
