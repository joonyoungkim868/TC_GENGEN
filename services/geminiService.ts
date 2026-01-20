
import { GoogleGenAI, Type, Schema, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { UploadedFile, TestCase } from '../types';
import { GEMINI_MODEL, SYSTEM_PROMPT_TEMPLATE } from '../constants';

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found");
  }
  return new GoogleGenAI({ apiKey });
};

// Define the response schema for strict JSON generation
const testCaseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        testCases: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    no: { type: Type.NUMBER },
                    title: { type: Type.STRING, description: "Test Case Title (in Korean)" },
                    depth1: { type: Type.STRING },
                    depth2: { type: Type.STRING },
                    depth3: { type: Type.STRING },
                    precondition: { 
                        type: Type.STRING, 
                        description: "List of states required BEFORE the test starts. MUST be a numbered list (1. Condition A\\n2. Condition B). Do NOT say 'None'." 
                    },
                    steps: { 
                        type: Type.STRING, 
                        description: "Detailed execution path. Start with Navigation path. Specify Input Data. Use numbered list." 
                    },
                    actionReasoning: { 
                        type: Type.STRING, 
                        description: "Logic/Reasoning for the expected result (Internal thought process)" 
                    },
                    expectedResult: { 
                        type: Type.STRING, 
                        description: "Final UI outcome. ONE atomic check only. INFER standard behavior if missing. Do NOT say 'Not specified'." 
                    },
                },
                required: ["no", "title", "steps", "expectedResult"] // Enforce required fields
            }
        },
        questions: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
        },
        summary: { type: Type.STRING }
    }
};

// 1. Bracket-based parser (Standard approach)
const parseViaBrackets = (text: string, result: { testCases: any[], questions: string[], summary: string }) => {
  let startIndex = 0;
  let maxIterations = 10000; 
  
  while (maxIterations-- > 0) {
      const openBrace = text.indexOf('{', startIndex);
      if (openBrace === -1) break;
      
      let balance = 0;
      let inString = false;
      let isEscaped = false;
      let foundEnd = false;
      
      for (let i = openBrace; i < text.length; i++) {
          const char = text[i];
          if (inString) {
              if (char === '\\') isEscaped = !isEscaped;
              else if (char === '"' && !isEscaped) inString = false;
              else isEscaped = false;
          } else {
              if (char === '"') inString = true;
              else if (char === '{') balance++;
              else if (char === '}') {
                  balance--;
                  if (balance === 0) {
                      const jsonChunk = text.substring(openBrace, i + 1);
                      try {
                          const obj = JSON.parse(jsonChunk);
                          
                          // Direct mapping, no normalization here to preserve structure
                          // merging will happen in mapToTestCases
                          if (obj.no !== undefined && (obj.title || obj.steps)) {
                              if (!result.testCases.some(tc => tc.no === obj.no)) {
                                result.testCases.push(obj);
                              }
                          } else if (Array.isArray(obj.testCases) || Array.isArray(obj.testcases)) {
                              const tcs = obj.testCases || obj.testcases;
                              tcs.forEach((tc: any) => {
                                  if (tc.no !== undefined && !result.testCases.some(exist => exist.no === tc.no)) {
                                      result.testCases.push(tc);
                                  }
                              });
                              if (obj.questions) result.questions = obj.questions;
                              if (obj.summary) result.summary = obj.summary;
                          }
                      } catch (e) {}
                      foundEnd = true;
                      startIndex = i + 1; 
                      break; 
                  }
              }
          }
      }
      if (!foundEnd) startIndex = openBrace + 1;
  }
};

// 2. Regex-based parser (Fallback)
const parseViaRegex = (text: string, result: { testCases: any[] }) => {
  // Global regex to match objects that look like {"no": ... }
  const objectRegex = /{\s*"no"\s*:\s*(\d+)[^}]*?}/gis;
  let match;

  while ((match = objectRegex.exec(text)) !== null) {
      const chunk = match[0];
      const no = parseInt(match[1]);
      
      if (result.testCases.some(tc => tc.no === no)) continue;

      const getField = (key: string) => {
        // Improved Regex:
        // Matches "key": "value"
        // Handles escaped quotes \" inside the string
        // Uses non-greedy matching .*? inside the quotes
        const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`, 'is'); 
        const m = regex.exec(chunk);
        return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : ''; // Basic unescape
      };

      const title = getField('title');
      const steps = getField('steps');

      if (title || steps) {
        result.testCases.push({
            no,
            title: title,
            depth1: getField('depth1'),
            depth2: getField('depth2'),
            depth3: getField('depth3'),
            precondition: getField('precondition'),
            steps: steps,
            expectedResult: getField('expectedResult')
        });
      }
  }
};

const recoverTruncatedJson = (text: string): { testCases: any[], questions: string[], summary: string } => {
  const result = {
    testCases: [] as any[],
    questions: [] as string[],
    summary: ""
  };
  const cleanText = text.replace(/```json/g, '').replace(/```/g, '');

  parseViaBrackets(cleanText, result);
  
  // Only run regex if brackets failed to find anything or found very few
  if (result.testCases.length === 0) {
      parseViaRegex(cleanText, result);
  }

  result.testCases.sort((a, b) => a.no - b.no);
  return result;
};

// 3. Post-processing Normalizer
const normalizeTestCases = (tcs: TestCase[]): TestCase[] => {
    return tcs.map(tc => {
        let formattedSteps = (tc.steps || "").trim();
        let formattedPrecond = (tc.precondition || "").trim();
        
        // Format steps to add newlines before step numbers (e.g., " 2." -> "\n2.")
        formattedSteps = formattedSteps.replace(/(\s+)(\d+\.)(?!\d)/g, '\n$2');
        formattedSteps = formattedSteps.replace(/^\n/, '');

        // Format precondition same way (force list structure if missing)
        formattedPrecond = formattedPrecond.replace(/(\s+)(\d+\.)(?!\d)/g, '\n$2');
        formattedPrecond = formattedPrecond.replace(/^\n/, '');
        
        // If precondition is not empty but doesn't start with "1.", try to fix it or leave it
        if (formattedPrecond && !/^\d+\./.test(formattedPrecond)) {
            // Optional: You could prepend "1. " here if you wanted to force it, 
            // but let's rely on the prompt first.
        }

        return {
            ...tc,
            title: (tc.title || "").trim(),
            steps: formattedSteps,
            precondition: formattedPrecond,
            expectedResult: (tc.expectedResult || "").trim()
        };
    });
};

// 4. Sort and Renumber (Grouping by Feature)
const postProcessTestCases = (testCases: TestCase[]): TestCase[] => {
    // Sort by Depth1 -> Depth2 -> Depth3 -> Original No (Phase order)
    const sorted = [...testCases].sort((a, b) => {
        const d1a = (a.depth1 || "").trim();
        const d1b = (b.depth1 || "").trim();
        if (d1a !== d1b) return d1a.localeCompare(d1b, 'ko');

        const d2a = (a.depth2 || "").trim();
        const d2b = (b.depth2 || "").trim();
        if (d2a !== d2b) return d2a.localeCompare(d2b, 'ko');

        const d3a = (a.depth3 || "").trim();
        const d3b = (b.depth3 || "").trim();
        if (d3a !== d3b) return d3a.localeCompare(d3b, 'ko');

        return a.no - b.no;
    });

    // Renumber sequentially
    return sorted.map((tc, index) => ({
        ...tc,
        no: index + 1
    }));
};

// Case-Insensitive Getter Helper
const getVal = (obj: any, keys: string[]): string => {
    if (!obj) return '';
    const objKeys = Object.keys(obj);
    for (const key of keys) {
        // 1. Try exact match
        if (obj[key] !== undefined) return obj[key];
        // 2. Try case-insensitive match
        const found = objKeys.find(k => k.toLowerCase() === key.toLowerCase());
        if (found) return obj[found];
    }
    return '';
};

const mapToTestCases = (rawTCs: any[]): TestCase[] => {
    return rawTCs.map((tc: any) => ({
        id: crypto.randomUUID(),
        no: Number(tc.no) || 0,
        title: getVal(tc, ['title', 'Title']),
        depth1: getVal(tc, ['depth1', 'Depth1']),
        depth2: getVal(tc, ['depth2', 'Depth2']),
        depth3: getVal(tc, ['depth3', 'Depth3']),
        precondition: getVal(tc, ['precondition', 'Precondition']),
        steps: getVal(tc, ['steps', 'Steps']),
        // Enhanced lookup for Expected Result to fix empty issues
        expectedResult: getVal(tc, ['expectedResult', 'ExpectedResult', 'expected_result']),
    }));
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const callGeminiWithRetry = async (
    ai: GoogleGenAI, 
    parts: any[], 
    baseSystemInstruction: string, 
    useSchema: boolean = true
): Promise<string> => {
    let apiAttempts = 0;
    const MAX_API_RETRIES = 3; 

    while (apiAttempts < MAX_API_RETRIES) {
        try {
            console.log(`[Gemini Request] Attempt ${apiAttempts + 1}`);

            const config: any = {
                systemInstruction: baseSystemInstruction,
                maxOutputTokens: 65536,
                // Strategy 1: Lower Temperature to 0.2 for Consistency
                temperature: 0.2, 
                responseMimeType: "application/json",
            };

            if (useSchema) {
                config.responseSchema = testCaseSchema;
            }

            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: { parts },
                config: config
            });

            if (response.text) {
                return response.text;
            }
            throw new Error("Empty response text");
        } catch (error: any) {
            apiAttempts++;
            console.error(`Gemini Attempt ${apiAttempts} failed:`, error.message);
            // Wait before retry
            if (apiAttempts < MAX_API_RETRIES) await delay(3000);
        }
    }
    throw new Error("Failed to get response from Gemini");
};

export const generateTestCases = async (
  files: UploadedFile[],
  styleFeedback: string
): Promise<{ testCases: TestCase[]; questions: string[]; summary: string }> => {
  const ai = getClient();
  
  // STRATEGY: 5 Strict Phases to force deep coverage and permutation
  const FOCUS_AREAS = [
      "Phase 1: [UI INSPECTION] Exhaustively test every visible clickable element (Buttons, Links, Tabs, Icons). One TC per element.",
      "Phase 2: [BOUNDARY & VALIDATION] Check Max/Min lengths, Special characters, and Empty inputs for ALL input fields.",
      "Phase 3: [VISUAL PERMUTATION] Create Truth Tables for all combinations of inputs (e.g., Checkbox A + Checkbox B). Test ALL combinations (O/O, O/X, X/O, X/X).",
      "Phase 4: [WORKFLOW STATE] Step-by-step process flows (Start -> Finish). Verify status changes (e.g., Pending -> Active).",
      "Phase 5: [NEGATIVE & EDGE] Interruption, Cancel buttons, Page refreshes during loading, Back navigation."
  ];

  let accumulatedTestCases: TestCase[] = [];
  let accumulatedQuestions: string[] = [];
  let finalSummary = "";
  
  let currentStartNo = 1;

  const baseParts: any[] = [];
  for (const file of files) {
    if (file.mimeType.startsWith('image/')) {
        const base64Data = file.content.split(',')[1] || file.content;
        baseParts.push({
            inlineData: {
                mimeType: file.mimeType,
                data: base64Data
            }
        });
    } else {
        baseParts.push({
            text: `[File: ${file.name}]\n${file.content}`
        });
    }
  }

  const baseSystemInstruction = SYSTEM_PROMPT_TEMPLATE.replace(
    '{{USER_FEEDBACK_DATA}}',
    styleFeedback || '(None)'
  );

  // Loop through each Phase
  for (let i = 0; i < FOCUS_AREAS.length; i++) {
      const currentPhase = FOCUS_AREAS[i];
      console.log(`[Gemini Loop] Starting ${currentPhase} - StartNo: ${currentStartNo}`);

      // Removed "Aim for 10" limit.
      // Explicitly requested ALL cases for the specific phase.
      const loopPrompt = `
      --- COMMAND ---
      CURRENT FOCUS: ${currentPhase}
      
      Generate Test Cases starting from No.${currentStartNo}.
      
      INSTRUCTION:
      1. Analyze the document/image specifically for this Phase.
      2. Generate **ALL** possible Test Cases that fit this phase's description. 
      3. If there are many combinations (Phase 3), generate them ALL. Do not summarize.
      4. Remember the "Atomic Rule": One TC = One Result.
      5. **Preconditions**: MUST be a numbered list (1. State A\n2. State B).
      
      Output ONLY valid JSON.
      Values MUST be in Korean.
      --- END COMMAND ---
      `;
      
      const parts = [...baseParts, { text: loopPrompt }];

      try {
          const responseText = await callGeminiWithRetry(ai, parts, baseSystemInstruction, true);
          
          let currentBatchTCs: TestCase[] = [];
          let currentBatchQuestions: string[] = [];
          
          const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
          
          try {
              const json = JSON.parse(cleanText);
              // REMOVED faulty normalizeKeys. We use strict robust mapping in mapToTestCases now.
              const tcs = json.testCases || json.testcases || [];
              currentBatchTCs = mapToTestCases(tcs);
              currentBatchQuestions = json.questions || [];
              if (json.summary) finalSummary += ` [${i+1}] ${json.summary}`;

          } catch (e) {
              console.warn("JSON Parse failed, attempting recovery...");
              const recovered = recoverTruncatedJson(responseText);
              currentBatchTCs = mapToTestCases(recovered.testCases);
              currentBatchQuestions = recovered.questions;
          }

          if (currentBatchTCs.length === 0) {
              console.warn(`[Phase ${i+1}] No TCs generated. Moving to next phase.`);
              continue; 
          }

          currentBatchTCs = normalizeTestCases(currentBatchTCs);

          // Append to total
          if (currentBatchTCs.length > 0) {
               accumulatedTestCases = [...accumulatedTestCases, ...currentBatchTCs];
               accumulatedQuestions = [...accumulatedQuestions, ...currentBatchQuestions];
               
               // Update start number for next loop
               const lastTC = currentBatchTCs[currentBatchTCs.length - 1];
               currentStartNo = (lastTC?.no || currentStartNo) + 1;
          }

      } catch (error) {
          console.error(`Error in loop ${i+1}:`, error);
          // Don't break completely, try next phase
      }
  }

  // Deduplicate by No just in case
  const uniqueTestCases = accumulatedTestCases.filter((tc, index, self) =>
    index === self.findIndex((t) => t.no === tc.no)
  );

  // Apply sorting and renumbering
  const finalTestCases = postProcessTestCases(uniqueTestCases);

  return {
    testCases: finalTestCases,
    questions: Array.from(new Set(accumulatedQuestions)),
    summary: finalSummary || `Generated ${finalTestCases.length} Test Cases across all phases.`
  };
};

export const updateTestCasesWithQA = async (
    files: UploadedFile[],
    currentTestCases: TestCase[],
    qaPairs: { question: string; answer: string }[],
    styleFeedback: string
): Promise<{ testCases: TestCase[]; questions: string[]; summary: string }> => {
    const ai = getClient();
    
    // Construct context
    const baseParts: any[] = [];
    for (const file of files) {
        if (file.mimeType.startsWith('image/')) {
            const base64Data = file.content.split(',')[1] || file.content;
            baseParts.push({
                inlineData: {
                    mimeType: file.mimeType,
                    data: base64Data
                }
            });
        } else {
            baseParts.push({ text: `[File: ${file.name}]\n${file.content}` });
        }
    }

    const qaText = qaPairs.map((qa, i) => `Q${i+1}: ${qa.question}\nA${i+1}: ${qa.answer}`).join('\n\n');
    
    // Summarize strictly to avoid token limit issues, but keep keys needed
    const currentTCSummary = JSON.stringify(currentTestCases.map(tc => ({
        no: tc.no,
        title: tc.title,
        steps: tc.steps
    })));

    const promptText = `
    --- UPDATE COMMAND ---
    User Q&A Session:
    ${qaText}

    Current Test Cases (Reference):
    ${currentTCSummary}

    Task:
    Re-generate the COMPLETE list of Test Cases (starting from No.1).
    Update based on the Q&A provided.
    
    CRITICAL:
    - Maintain the "Visual Permutation" rule.
    - Maintain the "Atomic Rule" (One Result per TC).
    - **Preconditions**: MUST be a numbered list (1. ... \n2. ...).
    
    Output ONLY valid JSON.
    Values MUST be in Korean.
    --- END COMMAND ---
    `;

    const parts = [...baseParts, { text: promptText }];
    const baseSystemInstruction = SYSTEM_PROMPT_TEMPLATE.replace(
        '{{USER_FEEDBACK_DATA}}',
        styleFeedback || 'Prioritize the information provided in the Q&A session.'
    );

    try {
        const responseText = await callGeminiWithRetry(ai, parts, baseSystemInstruction, true);
        
        let newTCs: TestCase[] = [];
        let newQuestions: string[] = [];
        let summary = "";

        const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
            const json = JSON.parse(cleanText);
            // REMOVED faulty normalizeKeys
            const tcs = json.testCases || json.testcases || [];
            newTCs = mapToTestCases(tcs);
            newQuestions = json.questions || [];
            summary = json.summary || "Updated based on Q&A.";
        } catch (e) {
            console.log("JSON parse failed during update, attempting recovery...");
            const recovered = recoverTruncatedJson(responseText);
            newTCs = mapToTestCases(recovered.testCases);
            newQuestions = recovered.questions;
        }

        newTCs = normalizeTestCases(newTCs);

        // Apply sorting and renumbering
        const finalTestCases = postProcessTestCases(newTCs);

        return {
            testCases: finalTestCases,
            questions: newQuestions,
            summary
        };

    } catch (error) {
        console.error("Error updating TCs with QA:", error);
        throw error;
    }
};
