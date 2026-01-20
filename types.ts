
export interface TestCase {
  id: string;
  no: number;
  title: string;
  depth1: string;
  depth2: string;
  depth3: string;
  precondition: string;
  steps: string;
  expectedResult: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  content: string; // Base64 for images, text for others
  mimeType: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  files: UploadedFile[];
  testCases: TestCase[];
  questions: string[]; // Persist questions
  styleFeedback: string;
  chatHistory: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: number;
}

export type ViewState = 'DASHBOARD' | 'SETUP' | 'WORKSPACE';
