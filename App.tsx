import React, { useState } from 'react';
import Dashboard from './components/Dashboard';
import ProjectSetup from './components/ProjectSetup';
import Workspace from './components/Workspace';
import { Project, ViewState, UploadedFile } from './types';
import { v4 as uuidv4 } from 'uuid';

function App() {
  const [viewState, setViewState] = useState<ViewState>('DASHBOARD');
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);

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
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    setCurrentProject(updated);
  };

  return (
    <div className="h-full w-full bg-slate-50">
      {viewState === 'DASHBOARD' && (
        <Dashboard 
          projects={projects}
          onCreateNew={handleCreateNew}
          onSelectProject={handleProjectSelect}
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
        />
      )}
    </div>
  );
}

export default App;
