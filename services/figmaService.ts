
import { UploadedFile } from '../types';
import { v4 as uuidv4 } from 'uuid';

const FIGMA_API_BASE = "https://api.figma.com/v1";

interface FigmaNode {
    id: string;
    name: string;
    type: string;
    children?: FigmaNode[];
    characters?: string; // Content for TEXT nodes
}

export interface FigmaPage {
    id: string;
    name: string;
}

// Helper to chunk array
const chunkArray = <T>(array: T[], size: number): T[][] => {
    const chunked: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunked.push(array.slice(i, i + size));
    }
    return chunked;
};

// Helper for delay with AbortSignal support
const delay = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            return reject(new DOMException('Aborted', 'AbortError'));
        }

        const timer = setTimeout(() => {
            resolve();
        }, ms);

        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
};

// --- PROXY ROTATION LOGIC ---

// API Calls require Header forwarding (Auth). 
// 'corsproxy.io' and 'thingproxy' usually support this. 'allorigins' might not.
const PROXY_GENERATORS_API = [
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://thingproxy.freeboard.io/fetch/${url}`, 
];

// Image Calls are signed URLs, no auth headers needed.
// We can use 'allorigins' safely here as well.
const PROXY_GENERATORS_IMAGE = [
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

const fetchViaProxy = async (
    targetUrl: string, 
    headers: any = {}, 
    signal?: AbortSignal, 
    isImage: boolean = false
): Promise<Response> => {
    const generators = isImage ? PROXY_GENERATORS_IMAGE : PROXY_GENERATORS_API;
    let lastError: any;

    for (let i = 0; i < generators.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        
        const generateUrl = generators[i];
        const proxyUrl = generateUrl(targetUrl);
        
        try {
            const response = await fetch(proxyUrl, { headers, signal });
            
            // If success, return response
            if (response.ok) return response;

            // Handle Specific Errors
            // 429: Rate Limit from Target -> Return (let caller handle backoff)
            // 401/403: Auth Error from Target -> Return (likely token issue)
            // 404: Not Found -> Return
            // We only rotate on 5xx (Server Error) or network failures
            if (response.status < 500) {
                 return response;
            }
            
            // 5xx errors might be Proxy errors. Try next proxy.
            console.warn(`[Proxy Rotation] Proxy ${i} returned ${response.status}. Rotating...`);
        } catch (error: any) {
            if (error.name === 'AbortError') throw error;
            console.warn(`[Proxy Rotation] Proxy ${i} network error. Rotating...`, error);
            lastError = error;
        }
    }
    throw lastError || new Error("All proxies failed to fetch the resource.");
};

// --- END PROXY LOGIC ---

// Helper for Fetch with Retry honoring 'Retry-After'
const fetchWithRetry = async (
    url: string, 
    headers: any, 
    signal?: AbortSignal,
    retries = 3, 
    defaultBackoff = 2000
): Promise<Response> => {
    try {
        // Use fetchViaProxy for API calls (isImage = false)
        const response = await fetchViaProxy(url, headers, signal, false);
        
        if (response.status === 429) {
            // Official Doc: Read 'Retry-After' header (seconds)
            const retryAfterHeader = response.headers.get('Retry-After');
            let waitTimeMs = defaultBackoff;

            if (retryAfterHeader) {
                const parsedVal = parseInt(retryAfterHeader, 10);
                if (!isNaN(parsedVal)) {
                    waitTimeMs = parsedVal * 1000;
                    const minutes = (parsedVal / 60).toFixed(1);
                    console.warn(`[Figma] Rate Limit (429). Server requested wait: ${parsedVal}s (${minutes} min). Waiting...`);
                }
            } else {
                console.warn(`[Figma] Rate Limit (429). No header, using backoff: ${waitTimeMs}ms`);
            }
            
            if (retries > 0) {
                // Wait (Abortable)
                // Add a small buffer (500ms) to be safe
                await delay(waitTimeMs + 500, signal);
                
                // Retry
                return fetchWithRetry(url, headers, signal, retries - 1, defaultBackoff * 2);
            }
        }
        return response;
    } catch (error: any) {
        // If aborted, rethrow immediately
        if (error.name === 'AbortError') {
            throw error;
        }

        if (retries > 0) {
            await delay(defaultBackoff, signal);
            return fetchWithRetry(url, headers, signal, retries - 1, defaultBackoff * 2);
        }
        throw error;
    }
};

// Extract file key from URL
const extractFileKey = (url: string): string | null => {
    const match = url.match(/(?:file|design|board)\/([a-zA-Z0-9]+)/);
    const key = match ? match[1] : null;
    return key;
};

// Recursively extract text
const extractTextFromNode = (node: FigmaNode): string => {
    if (node.type === 'TEXT' && node.characters) {
        return `- ${node.characters.trim()}\n`;
    }
    if (node.children) {
        return node.children.map(extractTextFromNode).join('');
    }
    return '';
};

// Convert image URL to Base64 (via Proxy Rotation)
const urlToBase64 = async (url: string, signal?: AbortSignal): Promise<string> => {
    try {
        // Use fetchViaProxy with isImage = true
        const response = await fetchViaProxy(url, {}, signal, true);
        if (!response.ok) return "";
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            // If aborted during file reading, we can't easily cancel FileReader but the promise chain is broken via fetch
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        // Ignore abort errors in logs, just return empty
        if ((error as any).name !== 'AbortError') {
            console.error("Image conversion failed", error);
        }
        return "";
    }
};

// Step 1: Get list of pages
export const getFigmaFilePages = async (
    fileUrl: string,
    accessToken: string,
    signal?: AbortSignal
): Promise<FigmaPage[]> => {
    const fileKey = extractFileKey(fileUrl);
    if (!fileKey) throw new Error("유효하지 않은 Figma URL입니다.");

    const headers = { 'X-Figma-Token': accessToken };
    const targetUrl = `${FIGMA_API_BASE}/files/${fileKey}?depth=1`;
    
    const resp = await fetchWithRetry(targetUrl, headers, signal);
    if (!resp.ok) throw new Error(`Figma 접근 실패: ${resp.status}`);

    const data = await resp.json();
    const pages = data.document.children
        .filter((child: any) => child.type === 'CANVAS')
        .map((p: any) => ({ id: p.id, name: p.name }));

    if (pages.length === 0) throw new Error("페이지가 없습니다.");
    return pages;
};

// Step 2: Optimized Process
export const processFigmaPage = async (
    fileUrl: string, 
    accessToken: string,
    pageId: string,
    onProgress: (msg: string) => void,
    signal?: AbortSignal
): Promise<UploadedFile[]> => {
    const fileKey = extractFileKey(fileUrl);
    if (!fileKey) throw new Error("유효하지 않은 Figma URL입니다.");

    const headers = { 'X-Figma-Token': accessToken };

    // 1. Get Frame List (Lightweight)
    onProgress("구조 분석 중...");
    const listUrl = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${pageId}&depth=1`;
    const listResp = await fetchWithRetry(listUrl, headers, signal);
    if (!listResp.ok) throw new Error("페이지 정보를 가져오는데 실패했습니다.");
    
    const listData = await listResp.json();
    const pageNode = listData.nodes[pageId]?.document;
    if (!pageNode) throw new Error("페이지 노드 없음");

    // Filter Targets
    const validTypes = ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP', 'TEXT'];
    const targets = pageNode.children.filter((child: any) => validTypes.includes(child.type));
    
    if (targets.length === 0) throw new Error("변환할 프레임, 그룹, 또는 텍스트가 없습니다.");
    console.log(`[Figma] Targets found: ${targets.length}`);

    // --- STRATEGY: Bulk Fetching ---
    
    const TEXT_BATCH_SIZE = 50; 
    const IMAGE_BATCH_SIZE = 20;

    const textMap: Record<string, string> = {};
    const imageUrlMap: Record<string, string> = {};

    // 2. Bulk Fetch Text Data (Include ALL targets)
    const frameChunksForText = chunkArray(targets, TEXT_BATCH_SIZE);
    for (let i = 0; i < frameChunksForText.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        
        const chunk = frameChunksForText[i];
        const ids = chunk.map((f: any) => f.id).join(',');
        onProgress(`텍스트 데이터 가져오는 중... (${i+1}/${frameChunksForText.length})`);
        
        try {
            // FIX 1: Add depth=10 to capture nested text in deep groups (Flowcharts)
            const nodesUrl = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${ids}&depth=10`;
            const resp = await fetchWithRetry(nodesUrl, headers, signal);
            if (resp.ok) {
                const data = await resp.json();
                Object.values(data.nodes).forEach((n: any) => {
                    if (n && n.document) {
                        textMap[n.document.id] = extractTextFromNode(n.document);
                    }
                });
            }
        } catch (e: any) {
            if (e.name === 'AbortError') throw e;
            console.warn(`[Figma] Text fetch warning (Batch ${i+1})`, e);
        }
        await delay(500, signal);
    }

    // 3. Bulk Fetch Image URLs
    const frameChunksForImages = chunkArray(targets, IMAGE_BATCH_SIZE);
    for (let i = 0; i < frameChunksForImages.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const chunk = frameChunksForImages[i];
        
        const targetIds = chunk
            .filter((f: any) => ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP'].includes(f.type))
            .map((f: any) => f.id);
        
        const renderableIds = targetIds.join(',');
        
        if (!renderableIds) continue; 

        onProgress(`이미지 주소 생성 중... (${i+1}/${frameChunksForImages.length})`);

        let batchData: any = { images: {} };
        let hasError = false;

        // Attempt 1: Normal Scale (0.5)
        try {
            const imgUrlReq = `${FIGMA_API_BASE}/images/${fileKey}?ids=${renderableIds}&format=jpg&scale=0.5`;
            const resp = await fetchWithRetry(imgUrlReq, headers, signal);
            if (resp.ok) {
                batchData = await resp.json();
            } else {
                hasError = true;
                console.warn(`[Figma] Image API (Scale 0.5) failed for batch ${i+1}.`);
            }
        } catch (e: any) {
            if (e.name === 'AbortError') throw e;
            hasError = true;
            console.warn(`[Figma] Image fetch exception (Scale 0.5).`, e);
        }

        // Fix 2: Retry Logic for Failed Images (Scale 0.1)
        // Identify IDs that returned null or are missing
        const failedIds = targetIds.filter(id => !batchData.images?.[id]);

        if (failedIds.length > 0) {
            onProgress(`대용량 이미지 저화질 재시도 중... (${failedIds.length}개)`);
            try {
                // Retry with much lower scale
                const retryIds = failedIds.join(',');
                const retryReq = `${FIGMA_API_BASE}/images/${fileKey}?ids=${retryIds}&format=jpg&scale=0.1`;
                const retryResp = await fetchWithRetry(retryReq, headers, signal);
                
                if (retryResp.ok) {
                    const retryData = await retryResp.json();
                    if (retryData.images) {
                        // Merge successful retries into the main data
                        Object.assign(batchData.images, retryData.images);
                        console.log(`[Figma] Recovered ${Object.keys(retryData.images).length} images via low-res retry.`);
                    }
                }
            } catch (e: any) {
                if (e.name === 'AbortError') throw e;
                console.warn(`[Figma] Retry (Scale 0.1) also failed.`, e);
            }
        }

        // Merge final results
        if (batchData.images) {
            Object.assign(imageUrlMap, batchData.images);
        }
        
        await delay(1000, signal);
    }

    // 4. Download & Assemble
    const uploadedFiles: UploadedFile[] = [];
    let processedCount = 0;

    for (const target of targets as FigmaNode[]) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        processedCount++;
        onProgress(`데이터 병합 중... (${processedCount}/${targets.length})`);

        const imgUrl = imageUrlMap[target.id];
        const txtContent = textMap[target.id];

        // Case A: Has Image
        if (imgUrl) {
            const base64 = await urlToBase64(imgUrl, signal);
            if (base64) {
                uploadedFiles.push({
                    id: uuidv4(),
                    name: `[Figma] ${target.name}.jpg`,
                    type: 'image/jpeg',
                    mimeType: 'image/jpeg',
                    content: base64
                });

                if (txtContent) {
                    uploadedFiles.push({
                        id: uuidv4(),
                        name: `[Figma_Text] ${target.name}.txt`,
                        type: 'text/plain',
                        mimeType: 'text/plain',
                        content: `\n# Screen: ${target.name}\n## Text Content\n${txtContent}`
                    });
                }
            }
        } 
        // Case B: No Image
        else if (txtContent) {
             if (txtContent.trim().length > 0) {
                 uploadedFiles.push({
                    id: uuidv4(),
                    name: `[Figma_Note] ${target.name}.txt`, 
                    type: 'text/plain',
                    mimeType: 'text/plain',
                    content: `\n# Spec/Note: ${target.name}\n## Content\n${txtContent}`
                });
             }
        }
    }

    if (uploadedFiles.length === 0) throw new Error("변환된 파일이 없습니다.");
    return uploadedFiles;
};
