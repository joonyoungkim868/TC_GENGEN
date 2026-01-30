
import React, { useState, useRef, useEffect } from 'react';
import { UploadedFile } from '../types';
import { UploadCloud, X, File as FileIcon, Loader2, Image as ImageIcon, AlertTriangle, Figma, Layout, ArrowRight, Layers, CheckSquare, Square } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { getFigmaFilePages, getFigmaFrames, processFigmaPage, FigmaPage, FigmaLayer } from '../services/figmaService';

interface ProjectSetupProps {
  onCancel: () => void;
  onComplete: (name: string, files: UploadedFile[]) => void;
}

type TabMode = 'UPLOAD' | 'FIGMA';
type FigmaStep = 'INPUT' | 'SELECT_PAGE' | 'SELECT_LAYER' | 'PROCESSING';

const ProjectSetup: React.FC<ProjectSetupProps> = ({ onCancel, onComplete }) => {
  const [mode, setMode] = useState<TabMode>('UPLOAD');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  
  // Generic Loading/Error
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Figma States
  const [figmaStep, setFigmaStep] = useState<FigmaStep>('INPUT');
  const [figmaToken, setFigmaToken] = useState('');
  const [figmaUrl, setFigmaUrl] = useState('');
  // Custom Proxy State removed as it is now hardcoded in service
  const [figmaPages, setFigmaPages] = useState<FigmaPage[]>([]);
  
  // Layer Selection State
  const [selectedPage, setSelectedPage] = useState<FigmaPage | null>(null);
  const [figmaLayers, setFigmaLayers] = useState<FigmaLayer[]>([]);
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());

  // Abort Controller Ref for cancelling previous requests
  const abortControllerRef = useRef<AbortController | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(Array.from(e.target.files));
    }
  };

  const processFiles = async (fileList: File[]) => {
    setErrorMsg(null);
    setIsLoading(true);
    const newFiles: UploadedFile[] = [];
    let rejectedCount = 0;

    for (const file of fileList) {
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') || file.name.endsWith('.json') || file.name.endsWith('.md') || file.name.endsWith('.csv');
      
      if (!isImage && !isText) {
          rejectedCount++;
          console.warn(`Skipped unsupported file: ${file.name} (${file.type})`);
          continue;
      }

      const reader = new FileReader();
      const content = await new Promise<string>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        if (isImage) {
          reader.readAsDataURL(file);
        } else {
          reader.readAsText(file);
        }
      });

      newFiles.push({
        id: uuidv4(),
        name: file.name,
        type: file.type,
        mimeType: file.type || 'text/plain',
        content: content
      });
    }

    if (rejectedCount > 0) {
        setErrorMsg(`${rejectedCount}개의 파일이 제외되었습니다. (지원 포맷: 이미지, 텍스트)`);
    }

    setFiles((prev) => [...prev, ...newFiles]);
    setIsLoading(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const removeFile = (id: string) => {
    setFiles(files.filter(f => f.id !== id));
  };

  // Step 1: Fetch Pages
  const handleFetchPages = async () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (!figmaToken.trim()) return setErrorMsg("Figma Access Token을 입력해주세요.");
      if (!figmaUrl.trim()) return setErrorMsg("Figma File URL을 입력해주세요.");

      setIsLoading(true);
      setErrorMsg(null);
      setLoadingMsg("파일 구조 분석 중...");

      try {
          // Removed customProxy argument
          const pages = await getFigmaFilePages(figmaUrl, figmaToken, controller.signal);
          setFigmaPages(pages);
          setFigmaStep('SELECT_PAGE');
      } catch (err: any) {
          if (err.name === 'AbortError') return;
          setErrorMsg(err.message || "Figma 페이지 목록을 가져오는데 실패했습니다.");
      } finally {
          setIsLoading(false);
          setLoadingMsg("");
          abortControllerRef.current = null;
      }
  };

  // Step 2: Fetch Layers (Frames) for selected Page
  const handlePageSelect = async (page: FigmaPage) => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      setErrorMsg(null);
      setLoadingMsg(`'${page.name}' 상세 구조 분석 중...`);
      setSelectedPage(page);

      try {
          // Removed customProxy argument
          const layers = await getFigmaFrames(figmaUrl, figmaToken, page.id, controller.signal);
          setFigmaLayers(layers);
          // Default: Select ALL layers
          setSelectedLayerIds(new Set(layers.map(l => l.id)));
          setFigmaStep('SELECT_LAYER');
      } catch (err: any) {
          if (err.name === 'AbortError') return;
          setErrorMsg(err.message || "페이지 상세 정보를 가져오는데 실패했습니다.");
      } finally {
          setIsLoading(false);
          setLoadingMsg("");
          abortControllerRef.current = null;
      }
  };

  // Step 3: Layer Selection Logic
  const toggleLayer = (id: string) => {
      const newSet = new Set(selectedLayerIds);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      setSelectedLayerIds(newSet);
  };

  const toggleAllLayers = () => {
      if (selectedLayerIds.size === figmaLayers.length) {
          setSelectedLayerIds(new Set()); // Deselect all
      } else {
          setSelectedLayerIds(new Set(figmaLayers.map(l => l.id))); // Select all
      }
  };

  // Step 4: Process Selected Layers
  const handleProcessLayers = async () => {
      if (selectedLayerIds.size === 0) return setErrorMsg("최소 1개의 프레임을 선택해주세요.");
      if (!selectedPage) return;

      if (abortControllerRef.current) abortControllerRef.current.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setFigmaStep('PROCESSING');
      setIsLoading(true);
      setErrorMsg(null);
      setLoadingMsg(`선택된 ${selectedLayerIds.size}개 프레임 다운로드 및 분석 중...`);

      try {
          // Removed customProxy argument
          const figmaFiles = await processFigmaPage(
              figmaUrl, 
              figmaToken, 
              selectedPage.id, 
              (msg) => setLoadingMsg(msg),
              controller.signal,
              Array.from(selectedLayerIds)
          );
          setFiles(prev => [...prev, ...figmaFiles]);
          setMode('UPLOAD'); // Switch to main view
          setFigmaStep('INPUT'); // Reset Figma flow
          if (!name) setName(`Figma Analysis - ${selectedPage.name}`);
      } catch (err: any) {
          if (err.name === 'AbortError') return;
          setErrorMsg(err.message || "데이터 처리 중 오류가 발생했습니다.");
          setFigmaStep('SELECT_LAYER'); // Return to layer selection on error
      } finally {
          setIsLoading(false);
          setLoadingMsg("");
          abortControllerRef.current = null;
      }
  };

  const handleCancelFigma = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
      }
      setIsLoading(false);
      
      // Navigate back based on current step
      if (figmaStep === 'SELECT_LAYER') setFigmaStep('SELECT_PAGE');
      else if (figmaStep === 'SELECT_PAGE') setFigmaStep('INPUT');
      else setFigmaStep('INPUT');
  };

  const handleSubmit = () => {
    if (!name.trim()) return alert("프로젝트 이름을 입력해주세요.");
    if (files.length === 0) return alert("최소 1개의 파일을 업로드해주세요.");
    onComplete(name, files);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h2 className="text-2xl font-bold text-slate-900 mb-6">새 프로젝트 설정</h2>
        
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              프로젝트 이름
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 회원가입 기능 기획서 분석"
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
            />
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-200">
              <button
                onClick={() => setMode('UPLOAD')}
                className={`pb-2 px-4 text-sm font-medium transition-colors border-b-2 ${mode === 'UPLOAD' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                  <div className="flex items-center gap-2">
                      <FileIcon size={16} /> 파일 업로드
                  </div>
              </button>
              <button
                onClick={() => setMode('FIGMA')}
                className={`pb-2 px-4 text-sm font-medium transition-colors border-b-2 ${mode === 'FIGMA' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                  <div className="flex items-center gap-2">
                      <Figma size={16} /> Figma 가져오기
                  </div>
              </button>
          </div>

          {/* Content Area */}
          <div className="min-h-[200px]">
            {mode === 'UPLOAD' ? (
                // Existing Upload Logic
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                    문서 업로드 (이미지, 텍스트 등)
                    </label>
                    <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                        isDragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-slate-400'
                    }`}
                    >
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        multiple
                        className="hidden"
                        accept="image/*,.txt,.csv,.json,.md" 
                    />
                    <UploadCloud className={`mx-auto h-12 w-12 mb-3 ${isDragOver ? 'text-blue-500' : 'text-slate-400'}`} />
                    <p className="text-slate-900 font-medium">클릭하거나 파일을 여기로 드래그하세요</p>
                    <p className="text-sm text-slate-500 mt-1">지원 포맷: PNG, JPG, WEBP, TXT, CSV, JSON</p>
                    </div>
                </div>
            ) : (
                // Figma Logic
                <div className="space-y-4 py-2">
                     <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                        {figmaStep === 'INPUT' && (
                            <>
                                <p className="text-sm text-slate-600 mb-3">
                                    Figma의 <strong>Personal Access Token</strong>을 사용하여 디자인을 분석합니다.
                                </p>
                                <div className="space-y-3">
                                    <div>
                                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Access Token</label>
                                        <input 
                                            type="password" 
                                            value={figmaToken}
                                            onChange={(e) => setFigmaToken(e.target.value)}
                                            placeholder="figd_..."
                                            className="w-full px-3 py-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 outline-none text-sm"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">File URL</label>
                                        <input 
                                            type="text" 
                                            value={figmaUrl}
                                            onChange={(e) => setFigmaUrl(e.target.value)}
                                            placeholder="https://www.figma.com/file/..."
                                            className="w-full px-3 py-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 outline-none text-sm"
                                        />
                                    </div>

                                    <button
                                        onClick={handleFetchPages}
                                        disabled={isLoading}
                                        className="w-full mt-2 bg-slate-800 text-white py-2 rounded hover:bg-slate-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                                    >
                                        {isLoading ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
                                        페이지 목록 가져오기
                                    </button>
                                </div>
                            </>
                        )}

                        {figmaStep === 'SELECT_PAGE' && (
                            <>
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="font-medium text-slate-900 flex items-center gap-2">
                                        <Layers size={18} className="text-blue-500" />
                                        분석할 페이지 선택
                                    </h3>
                                    <button 
                                        onClick={() => setFigmaStep('INPUT')}
                                        className="text-xs text-slate-500 hover:text-slate-800 underline"
                                    >
                                        정보 다시 입력
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                                    {figmaPages.map(page => (
                                        <button
                                            key={page.id}
                                            onClick={() => handlePageSelect(page)}
                                            className="p-3 text-left bg-white border border-slate-200 rounded hover:border-blue-400 hover:bg-blue-50 transition-all text-sm font-medium text-slate-700 truncate shadow-sm group"
                                        >
                                            <span className="block truncate">{page.name}</span>
                                            <span className="text-[10px] text-slate-400 group-hover:text-blue-400">클릭하여 레이어 선택</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}

                        {figmaStep === 'SELECT_LAYER' && selectedPage && (
                            <>
                                <div className="flex justify-between items-center mb-3">
                                    <div>
                                        <h3 className="font-medium text-slate-900 flex items-center gap-2">
                                            <Layout size={18} className="text-blue-500" />
                                            분석할 프레임 선택
                                        </h3>
                                        <p className="text-xs text-slate-500 mt-0.5">
                                            Page: {selectedPage.name} ({selectedLayerIds.size}개 선택됨)
                                        </p>
                                    </div>
                                    <div className="flex gap-2">
                                        <button 
                                            onClick={toggleAllLayers}
                                            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-600 transition-colors"
                                        >
                                            {selectedLayerIds.size === figmaLayers.length ? '전체 해제' : '전체 선택'}
                                        </button>
                                        <button 
                                            onClick={() => setFigmaStep('SELECT_PAGE')}
                                            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-600 transition-colors"
                                        >
                                            뒤로
                                        </button>
                                    </div>
                                </div>

                                <div className="bg-white border border-slate-200 rounded-lg max-h-64 overflow-y-auto p-1 space-y-0.5">
                                    {figmaLayers.length === 0 ? (
                                        <div className="p-4 text-center text-sm text-slate-500">
                                            이 페이지에는 분석 가능한 프레임이 없습니다.
                                        </div>
                                    ) : (
                                        figmaLayers.map(layer => {
                                            const isSelected = selectedLayerIds.has(layer.id);
                                            return (
                                                <div 
                                                    key={layer.id}
                                                    onClick={() => toggleLayer(layer.id)}
                                                    className={`flex items-center gap-3 p-2 rounded cursor-pointer text-sm transition-colors ${isSelected ? 'bg-blue-50 text-blue-900' : 'hover:bg-slate-50 text-slate-700'}`}
                                                >
                                                    <div className={`flex-shrink-0 ${isSelected ? 'text-blue-500' : 'text-slate-300'}`}>
                                                        {isSelected ? <CheckSquare size={18} /> : <Square size={18} />}
                                                    </div>
                                                    <div className="truncate flex-1">
                                                        <span className="font-medium">{layer.name}</span>
                                                        <span className="ml-2 text-[10px] text-slate-400 uppercase bg-slate-100 px-1 rounded">{layer.type}</span>
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                                
                                <button
                                    onClick={handleProcessLayers}
                                    disabled={selectedLayerIds.size === 0 || isLoading}
                                    className="w-full mt-3 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center justify-center gap-2"
                                >
                                    {isLoading ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
                                    선택한 프레임 분석 시작
                                </button>
                            </>
                        )}

                        {figmaStep === 'PROCESSING' && (
                            <div className="text-center py-8">
                                <Loader2 className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-3" />
                                <p className="text-slate-900 font-medium">{loadingMsg}</p>
                                <p className="text-slate-500 text-sm mt-1">이미지 렌더링에는 시간이 조금 걸릴 수 있습니다.</p>
                                <button 
                                    onClick={handleCancelFigma}
                                    className="mt-4 px-4 py-2 border border-slate-300 rounded text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                                >
                                    취소하고 다시 시도
                                </button>
                            </div>
                        )}
                     </div>
                </div>
            )}
            
            {errorMsg && (
                <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-lg flex items-start gap-2 text-sm text-red-700">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <span>{errorMsg}</span>
                </div>
            )}
          </div>

          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">업로드된 파일 ({files.length})</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center truncate">
                      {file.type.startsWith('image/') ? (
                        <ImageIcon size={18} className="text-blue-500 mr-2 flex-shrink-0" />
                      ) : (
                        <FileIcon size={18} className="text-slate-500 mr-2 flex-shrink-0" />
                      )}
                      <span className="text-sm text-slate-700 truncate">{file.name}</span>
                    </div>
                    <button
                      onClick={() => removeFile(file.id)}
                      className="text-slate-400 hover:text-red-500 transition-colors ml-2"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-8 pt-6 border-t border-slate-100">
          <button
            onClick={onCancel}
            className="px-5 py-2.5 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
          >
            프로젝트 생성
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProjectSetup;
