"""Shared API policy and upstream configuration."""

ITUNES = "https://itunes.apple.com"
PODCAST_INDEX = "https://api.podcastindex.org"
USER_AGENT = "Podr/1.0 (+https://www.podrapp.com) podcast-search"
UPSTREAM_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
TTL_SEARCH = 86400
TTL_TOP = 7200
TTL_DETAIL = 14400
TTL_SCHEMA = 31536000
STALE_SECONDS = 86400
EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"
GENRES = {
    1301: "Arts",
    1302: "Comedy",
    1303: "Education",
    1304: "Kids & Family",
    1305: "Health & Fitness",
    1306: "TV & Film",
    1307: "Music",
    1308: "News",
    1309: "Religion & Spirituality",
    1310: "Science",
    1311: "Sports",
    1312: "Technology",
    1313: "Business",
    1314: "Society & Culture",
    1315: "Government",
    1321: "Fiction",
    1323: "History",
    1324: "True Crime",
    1325: "Leisure",
    1326: "Documentary",
}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}
CORS_HEADERS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET"}
WARM_QUERIES = [
    "news",
    "comedy",
    "true crime",
    "technology",
    "business",
    "health",
    "sports",
    "music",
    "science",
    "history",
]
