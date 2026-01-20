
import React, { useState } from 'react';
import Dashboard from './components/Dashboard';
import ProjectSetup from './components/ProjectSetup';
import Workspace from './components/Workspace';
import { Project, ViewState, UploadedFile, TestCase } from './types';
import { v4 as uuidv4 } from 'uuid';
import { generateTestCases, updateTestCasesWithQA } from './services/geminiService';

// Track background generation state globally
interface GenerationState {
  isGenerating: boolean;
  message: string;
}

function App() {
  const [viewState, setViewState] = useState<ViewState>('DASHBOARD');
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  
  // State to track which projects are currently processing in the background
  const [generationStates, setGenerationStates] = useState<Record<string, GenerationState>>({});

  const handleCreateNew = () => {
    setViewState('SETUP');
  };

  const handleSetupComplete = (name: string, files: UploadedFile[]) => {
    const newProject: Project = {
      id: uuidv4(),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files,
      testCases: [],
      questions: [],
      styleFeedback: '',
      chatHistory: []
    };
    
    setProjects(prev => [newProject, ...prev]);
    setCurrentProject(newProject);
    setViewState('WORKSPACE');
  };

  const handleProjectSelect = (project: Project) => {
    setCurrentProject(project);
    setViewState('WORKSPACE');
  };

  const handleUpdateProject = (updated: Project) => {
    // 1. Update the master list
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    // 2. If this is the currently viewed project, update it too to reflect changes immediately
    if (currentProject && currentProject.id === updated.id) {
        setCurrentProject(updated);
    }
  };

  // --- Background Logic Start ---

  const setProjectGenState = (projectId: string, isGenerating: boolean, message: string) => {
    setGenerationStates(prev => ({
      ...prev,
      [projectId]: { isGenerating, message }
    }));
  };

  const handleGenerateTCs = async (projectId: string, files: UploadedFile[], styleFeedback: string) => {
    setProjectGenState(projectId, true, '문서를 분석하고 테스트 케이스를 생성 중입니다...');
    
    try {
      // Async API Call (Runs in background even if UI unmounts)
      const result = await generateTestCases(files, styleFeedback);
      
      // Update State safely using functional update to get latest projects state
      setProjects(prevProjects => {
        return prevProjects.map(p => {
          if (p.id === projectId) {
            return {
              ...p,
              testCases: [...p.testCases, ...result.testCases], // Append
              questions: result.questions, // Overwrite questions
              updatedAt: new Date().toISOString()
            };
          }
          return p;
        });
      });

      // Also update currentProject if we are looking at it
      if (currentProject?.id === projectId) {
          setCurrentProject(prev => prev ? ({
              ...prev,
              testCases: [...prev.testCases, ...result.testCases],
              questions: result.questions,
              updatedAt: new Date().toISOString()
          }) : null);
      }

      setProjectGenState(projectId, false, result.summary || 'TC 생성이 완료되었습니다.');

    } catch (error) {
      console.error(error);
      setProjectGenState(projectId, false, '오류가 발생했습니다. 다시 시도해주세요.');
    }
  };

  const handleRefineTCs = async (
      projectId: string, 
      files: UploadedFile[], 
      currentTCs: TestCase[], 
      qaPairs: { question: string; answer: string }[], 
      styleFeedback: string
  ) => {
      setProjectGenState(projectId, true, '답변을 분석하여 TC를 수정하고 있습니다...');

      try {
          const result = await updateTestCasesWithQA(files, currentTCs, qaPairs, styleFeedback);

          if (result.testCases.length === 0) {
              setProjectGenState(projectId, false, '⚠️ AI가 테스트 케이스를 생성하지 못했습니다.');
              return;
          }

          // Update State
          setProjects(prevProjects => {
            return prevProjects.map(p => {
              if (p.id === projectId) {
                return {
                  ...p,
                  testCases: result.testCases, // Replace
                  questions: result.questions, 
                  updatedAt: new Date().toISOString()
                };
              }
              return p;
            });
          });

          if (currentProject?.id === projectId) {
              setCurrentProject(prev => prev ? ({
                  ...prev,
                  testCases: result.testCases,
                  questions: result.questions,
                  updatedAt: new Date().toISOString()
              }) : null);
          }

          setProjectGenState(projectId, false, result.summary || '수정이 완료되었습니다.');

      } catch (error) {
          console.error(error);
          setProjectGenState(projectId, false, '수정 중 오류가 발생했습니다.');
      }
  };

  // --- Background Logic End ---

  return (
    <div className="h-full w-full bg-slate-50">
      {viewState === 'DASHBOARD' && (
        <Dashboard 
          projects={projects}
          onCreateNew={handleCreateNew}
          onSelectProject={handleProjectSelect}
          generationStates={generationStates}
        />
      )}
      
      {viewState === 'SETUP' && (
        <ProjectSetup 
          onCancel={() => setViewState('DASHBOARD')}
          onComplete={handleSetupComplete}
        />
      )}

      {viewState === 'WORKSPACE' && currentProject && (
        <Workspace 
          project={currentProject}
          onUpdateProject={handleUpdateProject}
          onBack={() => setViewState('DASHBOARD')}
          
          // Pass Background State & Functions
          isGenerating={generationStates[currentProject.id]?.isGenerating || false}
          generationMessage={generationStates[currentProject.id]?.message || ''}
          onGenerate={() => handleGenerateTCs(currentProject.id, currentProject.files, currentProject.styleFeedback)}
          onRefine={(qaPairs) => handleRefineTCs(currentProject.id, currentProject.files, currentProject.testCases, qaPairs, currentProject.styleFeedback)}
        />
      )}
    </div>
  );
}

export default App;
