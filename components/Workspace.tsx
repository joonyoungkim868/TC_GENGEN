
import React, { useState, useEffect } from 'react';
import { Project, TestCase } from '../types';
import { ArrowLeft, Save, Download, File as FileIcon, Sparkles, AlertCircle, CheckCircle } from 'lucide-react';
import { exportToExcel } from '../services/excelService';

interface WorkspaceProps {
  project: Project;
  onUpdateProject: (updatedProject: Project) => void;
  onBack: () => void;
  
  // Background Props
  isGenerating: boolean;
  generationMessage: string;
  onGenerate: () => void;
  onRefine: (qaPairs: { question: string; answer: string }[]) => void;
}

const Workspace: React.FC<WorkspaceProps> = ({ 
    project, 
    onUpdateProject, 
    onBack,
    isGenerating,
    generationMessage,
    onGenerate,
    onRefine
}) => {
  const [testCases, setTestCases] = useState<TestCase[]>(project.testCases || []);
  const [styleFeedback, setStyleFeedback] = useState(project.styleFeedback || '');
  const [questions, setQuestions] = useState<string[]>(project.questions || []); // Use persisted questions
  const [answers, setAnswers] = useState<{[key: number]: string}>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Sync with project updates (e.g. when background job finishes)
  useEffect(() => {
    if (project) {
        setTestCases(project.testCases);
        setQuestions(project.questions || []);
        // Note: We don't overwrite styleFeedback while typing usually, 
        // but here we sync it on load.
    }
  }, [project.testCases, project.questions, project.updatedAt]); // Dependency on specific fields to avoid loops

  const handleSave = () => {
    onUpdateProject({
      ...project,
      testCases,
      questions, // Save questions too
      styleFeedback,
      updatedAt: new Date().toISOString()
    });
  };

  const handleRefineWithAnswers = () => {
      const qaPairs = questions.map((q, idx) => ({
          question: q,
          answer: answers[idx] || "(No answer provided)"
      })).filter(pair => pair.answer !== "(No answer provided)");

      if (qaPairs.length === 0) {
          alert("답변을 하나 이상 입력해주세요.");
          return;
      }
      
      // Call parent
      onRefine(qaPairs);
      setAnswers({}); // Clear answers locally
  };

  const handleFeedbackSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!styleFeedback.trim()) return;
    handleSave();
    alert("피드백이 저장되었습니다. 다음 생성 시 반영됩니다.");
  };

  const handleExcelDownload = () => {
    if (testCases.length === 0) {
      alert("다운로드할 데이터가 없습니다.");
      return;
    }
    exportToExcel(testCases, project.name);
  };

  const handleCellChange = (id: string, field: keyof TestCase, value: string) => {
    // Lock editing while generating to avoid conflicts
    if (isGenerating) return; 
    setTestCases(prev => prev.map(tc => tc.id === id ? { ...tc, [field]: value } : tc));
  };

  const handleAnswerChange = (index: number, value: string) => {
      setAnswers(prev => ({ ...prev, [index]: value }));
  };

  // Render helpers
  const renderFilePreview = () => {
    const file = project.files.find(f => f.id === selectedFile);
    if (!file) return <div className="text-slate-400 p-8 text-center">파일을 선택하세요</div>;

    if (file.type.startsWith('image/')) {
        return <img src={file.content} alt={file.name} className="max-w-full h-auto rounded shadow-sm" />;
    }
    return <pre className="p-4 text-xs bg-slate-100 rounded overflow-auto h-full whitespace-pre-wrap">{file.content.substring(0, 1000)}...</pre>;
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <header className="flex-none h-16 border-b border-slate-200 px-4 flex items-center justify-between bg-white z-10">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-lg font-bold text-slate-900 truncate max-w-md">{project.name}</h1>
            <p className="text-xs text-slate-500">최종 수정: {new Date(project.updatedAt).toLocaleString()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
           <button 
            onClick={handleSave}
            disabled={isGenerating}
            className="flex items-center gap-2 px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save size={16} />
            저장
          </button>
          <button 
            onClick={handleExcelDownload}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg text-sm font-medium shadow-sm transition-colors"
          >
            <Download size={16} />
            엑셀 다운로드
          </button>
        </div>
      </header>

      {/* Main Content - 3 Panes */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Pane: Files */}
        <div className="w-64 flex-none border-r border-slate-200 bg-slate-50 flex flex-col">
            <div className="p-4 border-b border-slate-200">
                <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                    <FileIcon size={16} /> 원본 파일
                </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {project.files.map(file => (
                    <div 
                        key={file.id} 
                        onClick={() => setSelectedFile(file.id)}
                        className={`p-3 rounded-lg cursor-pointer text-sm flex items-center gap-2 transition-colors ${selectedFile === file.id ? 'bg-blue-100 text-blue-700 border border-blue-200' : 'hover:bg-slate-200 text-slate-600'}`}
                    >
                        <div className="w-8 h-8 rounded bg-slate-200 flex items-center justify-center flex-shrink-0 text-xs font-bold text-slate-500">
                            {file.type.startsWith('image/') ? 'IMG' : 'DOC'}
                        </div>
                        <span className="truncate">{file.name}</span>
                    </div>
                ))}
            </div>
            <div className="h-64 border-t border-slate-200 p-4 bg-white overflow-y-auto">
                <p className="text-xs font-semibold text-slate-500 mb-2">미리보기</p>
                {renderFilePreview()}
            </div>
        </div>

        {/* Center Pane: TC Grid */}
        <div className="flex-1 flex flex-col bg-slate-50 overflow-hidden relative">
            <div className="flex-none p-2 bg-white border-b border-slate-200 flex justify-between items-center">
                <h2 className="font-bold text-slate-800 px-2">Test Case Grid ({testCases.length})</h2>
                {questions.length > 0 && (
                    <div className="flex items-center gap-2 text-amber-600 bg-amber-50 px-3 py-1 rounded-full text-xs font-medium border border-amber-200">
                        <AlertCircle size={14} />
                        <span>AI 질문 {questions.length}건</span>
                    </div>
                )}
            </div>
            
            <div className="flex-1 overflow-auto p-4 relative">
                {/* Locking Overlay */}
                {isGenerating && (
                    <div className="absolute inset-0 bg-white/50 z-20 flex items-center justify-center backdrop-blur-[1px]">
                        <div className="bg-white p-6 rounded-2xl shadow-xl border border-blue-100 text-center max-w-sm">
                            <div className="mx-auto w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
                                <Sparkles className="animate-spin" />
                            </div>
                            <h3 className="text-lg font-bold text-slate-900 mb-2">AI가 열심히 작업 중입니다!</h3>
                            <p className="text-slate-500 text-sm mb-4">
                                문서를 분석하고 테스트 케이스를 생성하고 있습니다.<br/>
                                <strong>잠시 다른 작업을 하셔도 됩니다.</strong><br/>
                                (대시보드로 나가도 작업은 계속됩니다)
                            </p>
                            <p className="text-xs text-blue-600 font-medium bg-blue-50 py-1 px-3 rounded-full inline-block">
                                {generationMessage}
                            </p>
                        </div>
                    </div>
                )}

                <div className={`bg-white shadow rounded-lg overflow-hidden border border-slate-200 min-w-[1200px] ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}>
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-100 text-slate-700 font-semibold sticky top-0 z-10">
                            <tr>
                                <th className="px-3 py-3 w-12 border-b border-r border-slate-200 text-center">No</th>
                                <th className="px-3 py-3 w-48 border-b border-r border-slate-200">제목</th>
                                <th className="px-3 py-3 w-24 border-b border-r border-slate-200">1Depth</th>
                                <th className="px-3 py-3 w-24 border-b border-r border-slate-200">2Depth</th>
                                <th className="px-3 py-3 w-24 border-b border-r border-slate-200">3Depth</th>
                                <th className="px-3 py-3 w-48 border-b border-r border-slate-200">사전조건</th>
                                <th className="px-3 py-3 w-64 border-b border-r border-slate-200">절차</th>
                                <th className="px-3 py-3 w-64 border-b border-slate-200">예상결과</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {testCases.map((tc, idx) => (
                                <tr key={tc.id} className="hover:bg-slate-50">
                                    <td className="p-2 border-r border-slate-200 text-center text-slate-500">{idx + 1}</td>
                                    <td className="p-0 border-r border-slate-200">
                                        <input className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50" value={tc.title} onChange={e => handleCellChange(tc.id, 'title', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-r border-slate-200">
                                        <input className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50" value={tc.depth1} onChange={e => handleCellChange(tc.id, 'depth1', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-r border-slate-200">
                                        <input className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50" value={tc.depth2} onChange={e => handleCellChange(tc.id, 'depth2', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-r border-slate-200">
                                        <input className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50" value={tc.depth3} onChange={e => handleCellChange(tc.id, 'depth3', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-r border-slate-200">
                                        <textarea className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50 resize-none overflow-hidden min-h-[40px]" rows={1} value={tc.precondition} onChange={e => handleCellChange(tc.id, 'precondition', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-r border-slate-200">
                                        <textarea className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50 resize-none overflow-hidden min-h-[40px]" rows={1} value={tc.steps} onChange={e => handleCellChange(tc.id, 'steps', e.target.value)} />
                                    </td>
                                    <td className="p-0 border-slate-200">
                                        <textarea className="w-full h-full p-2 bg-transparent outline-none focus:bg-blue-50 resize-none overflow-hidden min-h-[40px]" rows={1} value={tc.expectedResult} onChange={e => handleCellChange(tc.id, 'expectedResult', e.target.value)} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {testCases.length === 0 && (
                        <div className="p-10 text-center text-slate-400">
                            생성된 테스트 케이스가 없습니다. 우측 메뉴에서 분석을 시작하세요.
                        </div>
                    )}
                </div>
            </div>
        </div>

        {/* Right Pane: AI Feedback Center */}
        <div className="w-80 flex-none border-l border-slate-200 bg-white flex flex-col shadow-xl z-20">
            <div className="p-4 bg-slate-800 text-white flex justify-between items-center">
                <h3 className="font-semibold flex items-center gap-2">
                    <Sparkles size={16} className="text-yellow-400" /> AI Feedback Center
                </h3>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Status Card */}
                <div className={`bg-slate-50 rounded-lg p-4 border ${isGenerating ? 'border-blue-200 bg-blue-50' : 'border-slate-200'}`}>
                    <h4 className="font-medium text-slate-800 text-sm mb-2">분석 상태</h4>
                    {isGenerating ? (
                        <div className="flex items-center gap-2 text-blue-600 text-sm animate-pulse font-medium">
                            <Sparkles size={14} /> 작업 처리 중...
                        </div>
                    ) : (
                        <div className="text-sm text-slate-500">대기 중</div>
                    )}
                    {(generationMessage) && (
                        <div className="mt-2 text-sm text-slate-700 bg-white p-2 rounded border border-slate-200">
                            {generationMessage}
                        </div>
                    )}
                </div>

                {/* Questions / Q&A Card */}
                {questions.length > 0 && !isGenerating && (
                    <div className="bg-amber-50 rounded-lg border border-amber-200 overflow-hidden">
                        <div className="p-3 bg-amber-100/50 border-b border-amber-200">
                            <h4 className="font-medium text-amber-800 text-sm flex items-center gap-1">
                                <AlertCircle size={14} /> 확인 필요 사항 ({questions.length})
                            </h4>
                        </div>
                        <div className="p-3 space-y-4">
                            {questions.map((q, i) => (
                                <div key={i} className="space-y-1.5">
                                    <p className="text-xs text-amber-900 font-medium break-words">Q. {q}</p>
                                    <textarea 
                                        value={answers[i] || ''}
                                        onChange={(e) => handleAnswerChange(i, e.target.value)}
                                        placeholder="답변을 입력하세요..."
                                        className="w-full p-2 text-xs border border-amber-200 rounded focus:ring-1 focus:ring-amber-500 outline-none resize-none bg-white"
                                        rows={2}
                                    />
                                </div>
                            ))}
                            <button 
                                onClick={handleRefineWithAnswers}
                                disabled={isGenerating}
                                className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded shadow-sm transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
                            >
                                <CheckCircle size={12} /> 답변 반영 및 TC 수정
                            </button>
                        </div>
                    </div>
                )}

                {/* Style Feedback Input */}
                <div className={`bg-white rounded-lg border border-blue-100 shadow-sm p-1 ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}>
                    <div className="p-3 bg-blue-50 border-b border-blue-100 rounded-t-lg">
                        <h4 className="font-medium text-blue-900 text-sm">스타일 피드백 (Context)</h4>
                        <p className="text-xs text-blue-600 mt-1">
                            AI에게 원하는 작성 스타일을 알려주세요.
                        </p>
                    </div>
                    <form onSubmit={handleFeedbackSubmit} className="p-3">
                        <textarea
                            value={styleFeedback}
                            onChange={(e) => setStyleFeedback(e.target.value)}
                            className="w-full h-24 p-2 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none resize-none mb-2"
                            placeholder="예: 단계는 반드시 명사형으로 끝내줘. 사전조건은 상세하게 작성해줘."
                        />
                        <button
                            type="submit"
                            className="w-full py-2 bg-slate-800 text-white text-xs font-medium rounded hover:bg-slate-700 transition-colors"
                        >
                            피드백 저장
                        </button>
                    </form>
                </div>
            </div>

            {/* Action Area */}
            <div className="p-4 border-t border-slate-200 bg-slate-50">
                <button
                    onClick={onGenerate}
                    disabled={isGenerating}
                    className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold rounded-lg shadow-sm transition-all flex items-center justify-center gap-2"
                >
                    {isGenerating ? (
                        <>생성 중...</>
                    ) : (
                        <>
                            <Sparkles size={18} />
                            TC 초안 생성 (초기화)
                        </>
                    )}
                </button>
                <p className="text-xs text-center text-slate-400 mt-2">
                    '초안 생성'은 기존 TC를 초기화하고 새로 생성합니다.
                </p>
            </div>
        </div>
      </div>
    </div>
  );
};

export default Workspace;
