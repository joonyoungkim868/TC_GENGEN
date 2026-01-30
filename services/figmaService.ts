
import { UploadedFile } from '../types';
import { v4 as uuidv4 } from 'uuid';

const FIGMA_API_BASE = "https://api.figma.com/v1";
// Hardcoded Custom Proxy URL provided by user
const FIXED_PROXY_URL = "https://weathered-rice-71c4.red-smoke-22ef.workers.dev";

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
    type: string;
}

export interface FigmaLayer {
    id: string;
    name: string;
    type: string;
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

// --- PROXY STRATEGY ---

const PROXY_GENERATORS_IMAGE = [
    (url: string) => `https://wsrv.nl/?url=${encodeURIComponent(url)}`, 
    (url: string) => `https://images.weserv.nl/?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

const fetchViaProxy = async (
    targetUrl: string, 
    headers: any = {}, 
    signal?: AbortSignal, 
    isImage: boolean = false
): Promise<Response> => {
    let generators: ((url: string) => string)[];

    if (!isImage) {
        // [API CALLS] Use the robust FIXED Custom Worker
        // Ensure no trailing slash and append query
        const cleanProxy = FIXED_PROXY_URL.replace(/\/$/, '');
        generators = [(url) => `${cleanProxy}?url=${encodeURIComponent(url)}`];
    } else {
        // [IMAGE CALLS] Use Image CDNs for performance & bandwidth saving on the worker
        generators = PROXY_GENERATORS_IMAGE;
    }

    let lastError: any;

    for (let i = 0; i < generators.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        
        const generateUrl = generators[i];
        const proxyUrl = generateUrl(targetUrl);
        
        try {
            const response = await fetch(proxyUrl, { headers, signal });
            
            if (response.status === 404) return response;

            // 429 Logic
            if (response.status === 429) {
                // If it's the Fixed Proxy (API) or the last Image proxy, return 429 to let retry logic handle it.
                if (generators.length === 1 || i === generators.length - 1) {
                    return response; 
                }
                console.warn(`[Proxy ${i}] Rate Limited. Rotating...`);
                continue; 
            }

            if (response.ok) return response;
            
            // Server Error -> Rotate
            if (response.status >= 500) {
                 console.warn(`[Proxy ${i}] Server Error ${response.status}. Rotating...`);
                 continue;
            }
            
            return response;

        } catch (error: any) {
            if (error.name === 'AbortError') throw error;
            console.warn(`[Proxy ${i}] Network Error: ${error.message}. Rotating...`);
            lastError = error;
        }

        if (i < generators.length - 1) await delay(500, signal);
    }
    
    throw lastError || new Error("All proxies failed to fetch.");
};

// --- END PROXY LOGIC ---

// Helper for Fetch with Retry honoring 'Retry-After'
const fetchWithRetry = async (
    url: string, 
    headers: any, 
    signal?: AbortSignal,
    retries = 3, 
    defaultBackoff = 3000
): Promise<Response> => {
    try {
        const response = await fetchViaProxy(url, headers, signal, false);
        
        if (response.status === 429) {
            if (retries <= 0) throw new Error("API Rate Limit Exceeded (Max Retries Reached)");

            const retryAfterHeader = response.headers.get('Retry-After');
            let waitTimeMs = defaultBackoff;

            if (retryAfterHeader) {
                const parsedVal = parseInt(retryAfterHeader, 10);
                if (!isNaN(parsedVal)) {
                    waitTimeMs = parsedVal * 1000;
                    console.warn(`[Figma] Server requested wait: ${parsedVal}s.`);
                    
                    if (waitTimeMs > 60000) {
                        throw new Error(`프록시 서버가 과도한 요청으로 차단되었습니다 (대기: ${parsedVal}초). 잠시 후 다시 시도해주세요.`);
                    }
                }
            } else {
                waitTimeMs = Math.max(defaultBackoff, 3000); 
            }
            
            console.warn(`[Figma API] 429 Hit. Pausing for ${waitTimeMs/1000}s... (Retries left: ${retries})`);
            await delay(waitTimeMs, signal);
            
            return fetchWithRetry(url, headers, signal, retries - 1, waitTimeMs * 1.5);
        }

        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        if (retries > 0) {
            if (error.message.includes("프록시 서버가")) throw error;

            console.warn(`[Figma API] Network/Fetch Error. Retrying... (${retries})`);
            await delay(2000, signal);
            return fetchWithRetry(url, headers, signal, retries - 1, defaultBackoff);
        }
        throw error;
    }
};

const extractFileKey = (url: string): string | null => {
    const match = url.match(/(?:file|design|board)\/([a-zA-Z0-9]+)/);
    const key = match ? match[1] : null;
    return key;
};

const extractTextFromNode = (node: FigmaNode): string => {
    if (node.type === 'TEXT' && node.characters) {
        return `- ${node.characters.trim()}\n`;
    }
    if (node.children) {
        return node.children.map(extractTextFromNode).join('');
    }
    return '';
};

const urlToBase64 = async (url: string, signal?: AbortSignal, retries = 2): Promise<string> => {
    try {
        const response = await fetchViaProxy(url, {}, signal, true); // isImage = true
        if (!response.ok) {
            throw new Error(`Image fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        if ((error as any).name === 'AbortError') throw error;
        
        if (retries > 0) {
            await delay(1000, signal);
            return urlToBase64(url, signal, retries - 1);
        }
        return "";
    }
};

export const getFigmaFilePages = async (
    fileUrl: string,
    accessToken: string,
    signal?: AbortSignal
): Promise<FigmaPage[]> => {
    const fileKey = extractFileKey(fileUrl);
    if (!fileKey) throw new Error("유효하지 않은 Figma URL입니다.");

    const headers = { 'X-Figma-Token': accessToken };
    const targetUrl = `${FIGMA_API_BASE}/files/${fileKey}?depth=1`;
    
    const resp = await fetchWithRetry(targetUrl, headers, signal, 3, 3000);
    if (!resp.ok) throw new Error(`Figma 접근 실패: ${resp.status} (토큰을 확인해주세요)`);

    const data = await resp.json();
    const pages = data.document.children
        .filter((child: any) => child.type === 'CANVAS')
        .map((p: any) => ({ id: p.id, name: p.name }));

    if (pages.length === 0) throw new Error("페이지가 없습니다.");
    return pages;
};

export const getFigmaFrames = async (
    fileUrl: string,
    accessToken: string,
    pageId: string,
    signal?: AbortSignal
): Promise<FigmaLayer[]> => {
    const fileKey = extractFileKey(fileUrl);
    if (!fileKey) throw new Error("유효하지 않은 Figma URL입니다.");

    const headers = { 'X-Figma-Token': accessToken };
    const listUrl = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${pageId}&depth=1`;
    
    const resp = await fetchWithRetry(listUrl, headers, signal, 3, 3000);
    if (!resp.ok) throw new Error("레이어 정보를 가져오는데 실패했습니다.");

    const data = await resp.json();
    const pageNode = data.nodes[pageId]?.document;
    if (!pageNode) throw new Error("페이지 노드를 찾을 수 없습니다.");

    const validTypes = ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP'];
    const layers = pageNode.children
        .filter((child: any) => validTypes.includes(child.type))
        .map((child: any) => ({
            id: child.id,
            name: child.name,
            type: child.type
        }));

    return layers;
};

export const processFigmaPage = async (
    fileUrl: string, 
    accessToken: string,
    pageId: string,
    onProgress: (msg: string) => void,
    signal?: AbortSignal,
    targetNodeIds?: string[]
): Promise<UploadedFile[]> => {
    const fileKey = extractFileKey(fileUrl);
    if (!fileKey) throw new Error("유효하지 않은 Figma URL입니다.");

    const headers = { 'X-Figma-Token': accessToken };

    onProgress("구조 분석 중...");
    const listUrl = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${pageId}&depth=1`;
    const listResp = await fetchWithRetry(listUrl, headers, signal, 3, 3000);
    if (!listResp.ok) throw new Error("페이지 정보를 가져오는데 실패했습니다.");
    
    const listData = await listResp.json();
    const pageNode = listData.nodes[pageId]?.document;
    if (!pageNode) throw new Error("페이지 노드 없음");

    const validTypes = ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP', 'TEXT'];
    let targets = pageNode.children.filter((child: any) => validTypes.includes(child.type));
    
    if (targetNodeIds && targetNodeIds.length > 0) {
        targets = targets.filter((child: any) => targetNodeIds.includes(child.id));
    }

    if (targets.length === 0) throw new Error("선택된 프레임이 없거나 유효하지 않습니다.");
    console.log(`[Figma] Targets found: ${targets.length}`);

    const TEXT_BATCH_SIZE = 15; 
    const IMAGE_BATCH_SIZE = 5;

    const textMap: Record<string, string> = {};
    const imageUrlMap: Record<string, string> = {};

    // 2. Bulk Fetch Text Data
    const frameChunksForText = chunkArray(targets, TEXT_BATCH_SIZE);
    for (let i = 0; i < frameChunksForText.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = frameChunksForText[i];
        const ids = chunk.map((f: any) => f.id).join(',');
        onProgress(`텍스트 데이터 가져오는 중... (${i+1}/${frameChunksForText.length})`);
        try {
            const nodesUrl = `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${ids}&depth=10`;
            const resp = await fetchWithRetry(nodesUrl, headers, signal, 3, 3000);
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
            console.warn("[Figma] Text fetch warning:", e.message);
        }
        await delay(2000, signal); 
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

        try {
            const imgUrlReq = `${FIGMA_API_BASE}/images/${fileKey}?ids=${renderableIds}&format=jpg&scale=0.5`;
            const resp = await fetchWithRetry(imgUrlReq, headers, signal, 3, 3000);
            if (resp.ok) {
                batchData = await resp.json();
            }
        } catch (e: any) {
            if (e.name === 'AbortError') throw e;
            console.warn(`[Figma] Image URL fetch warning:`, e.message);
        }

        // Retry Logic
        const failedIds = targetIds.filter(id => !batchData.images?.[id]);
        if (failedIds.length > 0) {
            onProgress(`대용량 이미지 저화질 재시도 중... (${failedIds.length}개)`);
            try {
                const retryIds = failedIds.join(',');
                const retryReq = `${FIGMA_API_BASE}/images/${fileKey}?ids=${retryIds}&format=jpg&scale=0.1`;
                const retryResp = await fetchWithRetry(retryReq, headers, signal, 3, 3000);
                if (retryResp.ok) {
                    const retryData = await retryResp.json();
                    if (retryData.images) Object.assign(batchData.images, retryData.images);
                }
            } catch (e: any) {
                if (e.name === 'AbortError') throw e;
            }
        }
        if (batchData.images) Object.assign(imageUrlMap, batchData.images);
        await delay(2000, signal);
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

        let imageAdded = false;

        if (imgUrl) {
            const base64 = await urlToBase64(imgUrl, signal, 2);
            if (base64) {
                imageAdded = true;
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
            } else {
                console.warn(`[Figma] Image download failed for ${target.name}, falling back to text only.`);
            }
        } 
        
        if (!imageAdded) {
             const cleanText = txtContent ? txtContent.trim() : "";
             uploadedFiles.push({
                id: uuidv4(),
                name: `[Figma_Note] ${target.name}.txt`, 
                type: 'text/plain',
                mimeType: 'text/plain',
                content: `\n# Screen: ${target.name}\n## Status\n⚠️ 이미지 다운로드 실패 (접근 권한 또는 네트워크 오류)\n## Text Content\n${cleanText || "(텍스트 없음)"}`
            });
        }
    }

    if (uploadedFiles.length === 0) throw new Error("변환된 파일이 없습니다.");
    return uploadedFiles;
};
