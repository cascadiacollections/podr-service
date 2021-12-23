type ApiCall = () => Promise<Response>;

/**
 * 
 * @param query 
 * @param limit 
 * @returns 
 */
async function searchRequest(query = 'smodcast', limit = 5): Promise<Response> {
    const SEARCH_URL = `https://itunes.apple.com/search?media=podcast&term=${query}&limit=${limit}`;
    const response = await fetch(SEARCH_URL);

    return response.json();
}

/**
 * 
 * @returns 
 */
async function rssRequest(): Promise<Response> {
    return new Response(JSON.stringify({}, null, 2));
}

export { rssRequest, searchRequest, ApiCall };