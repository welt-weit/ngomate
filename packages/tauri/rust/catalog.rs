/// Models the app offers, pinned to a revision and checksum, so what passed testing is what downloads.
/// `min_ram_gb` leaves room for the system and other programs.
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
        min_ram_gb: 12,
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
        min_ram_gb: 12,
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
        min_ram_gb: 12,
    },
    Model {
        id: "qwen3-4b-q4",
        name: "Qwen 3 4B",
        vendor: "Alibaba",
        license: "Apache-2.0",
        url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
        file: "Qwen3-4B-Q4_K_M.gguf",
        sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        size_bytes: 2497280256,
        min_ram_gb: 6,
    },
    Model {
        id: "granite-4.2-3b-q4",
        name: "Granite 4.2 3B",
        vendor: "IBM",
        license: "Apache-2.0",
        url: "https://huggingface.co/ibm-granite/granite-4.2-3b-GGUF/resolve/c40945d71cd90f249a56985e8155551a9188dc30/granite-4.2-3b-Q4_K_M.gguf",
        file: "granite-4.2-3b-Q4_K_M.gguf",
        sha256: "e0406663965846ae22a403456eb826ccce5f450840491f71952f18a7cb78e7d5",
        size_bytes: 2244011552,
        min_ram_gb: 4,
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}
