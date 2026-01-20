
import React from 'react';
import { Project } from '../types';
import { FolderPlus, FileText, Calendar, ArrowRight, Loader2, Sparkles } from 'lucide-react';

interface DashboardProps {
  projects: Project[];
  onCreateNew: () => void;
  onSelectProject: (project: Project) => void;
  generationStates: Record<string, { isGenerating: boolean; message: string }>;
}

const Dashboard: React.FC<DashboardProps> = ({ projects, onCreateNew, onSelectProject, generationStates }) => {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-slate-500">QA Draft Master 프로젝트 관리</p>
        </div>
        <button
          onClick={onCreateNew}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg shadow-sm transition-colors font-medium"
        >
          <FolderPlus size={20} />
          신규 TestCase 프로젝트 생성
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
          <FileText className="mx-auto h-16 w-16 text-slate-300 mb-4" />
          <h3 className="text-lg font-medium text-slate-900">프로젝트가 없습니다</h3>
          <p className="mt-1 text-slate-500">새로운 프로젝트를 생성하여 문서를 분석해보세요.</p>
          <button
            onClick={onCreateNew}
            className="mt-6 inline-flex items-center text-blue-600 hover:text-blue-700 font-medium"
          >
            시작하기 <ArrowRight size={16} className="ml-1" />
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => {
            const genState = generationStates[project.id];
            const isProcessing = genState?.isGenerating;

            return (
              <div
                key={project.id}
                onClick={() => onSelectProject(project)}
                className={`bg-white rounded-xl border p-6 hover:shadow-lg transition-all cursor-pointer group relative overflow-hidden ${isProcessing ? 'border-blue-300 ring-1 ring-blue-100' : 'border-slate-200'}`}
              >
                {/* Background Progress Indicator */}
                {isProcessing && (
                   <div className="absolute top-0 left-0 w-full h-1 bg-blue-100">
                      <div className="h-full bg-blue-500 animate-progress-indeterminate"></div>
                   </div>
                )}

                <div className="flex justify-between items-start mb-4">
                  <div className={`p-3 rounded-lg transition-colors ${isProcessing ? 'bg-blue-100' : 'bg-blue-50 group-hover:bg-blue-100'}`}>
                    {isProcessing ? (
                        <Loader2 className="text-blue-600 animate-spin" size={24} />
                    ) : (
                        <FileText className="text-blue-600" size={24} />
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                      <span className="text-xs font-medium bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">
                        TC {project.testCases.length}개
                      </span>
                      {isProcessing && (
                          <span className="text-[10px] font-bold text-blue-600 flex items-center gap-1 animate-pulse">
                              <Sparkles size={10} />
                              AI 분석 중...
                          </span>
                      )}
                  </div>
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2 truncate">
                  {project.name}
                </h3>
                
                {/* Status Message Preview if processing */}
                {isProcessing ? (
                     <div className="flex items-center text-sm text-blue-600 mb-4 h-5">
                        <span className="truncate">{genState.message}</span>
                     </div>
                ) : (
                    <div className="flex items-center text-sm text-slate-500 mb-4 space-x-4 h-5">
                        <div className="flex items-center">
                        <FolderPlus size={14} className="mr-1.5" />
                        {project.files.length} 파일
                        </div>
                        <div className="flex items-center">
                        <Calendar size={14} className="mr-1.5" />
                        {new Date(project.updatedAt).toLocaleDateString()}
                        </div>
                    </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <style>{`
        @keyframes progress-indeterminate {
          0% { margin-left: -50%; width: 50%; }
          100% { margin-left: 100%; width: 50%; }
        }
        .animate-progress-indeterminate {
          animation: progress-indeterminate 1.5s infinite linear;
        }
      `}</style>
    </div>
  );
};

export default Dashboard;
