
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
                        description: "List of states required BEFORE the test starts. MUST be a numbered list (1. State A\\n2. State B). Do NOT say 'None'." 
                    },
                    steps: { 
                        type: Type.STRING, 
                        description: "Detailed execution path. Start with Navigation path. Specify Input Data. Use numbered list. End with Noun (명사형). DO NOT end with a period." 
                    },
                    expectedResult: { 
                        type: Type.STRING, 
                        description: "Final UI outcome. ONE atomic check only. Use Passive Voice (~된다). Do NOT say 'Check'." 
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
                          
                          if (obj.no !== undefined && (obj.title || obj.steps)) {
                              result.testCases.push(obj);
                          } else if (Array.isArray(obj.testCases) || Array.isArray(obj.testcases)) {
                              const tcs = obj.testCases || obj.testcases;
                              tcs.forEach((tc: any) => {
                                  if (tc.no !== undefined) {
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
  const objectRegex = /{\s*"no"\s*:\s*(\d+)[^}]*?}/gis;
  let match;

  while ((match = objectRegex.exec(text)) !== null) {
      const chunk = match[0];
      const no = parseInt(match[1]);
      
      const getField = (key: string) => {
        const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`, 'is'); 
        const m = regex.exec(chunk);
        return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : ''; 
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
  
  if (result.testCases.length === 0) {
      parseViaRegex(cleanText, result);
  }

  return result;
};

// 3. Post-processing Normalizer
const normalizeTestCases = (tcs: TestCase[]): TestCase[] => {
    return tcs.map(tc => {
        let formattedSteps = (tc.steps || "").trim();
        let formattedPrecond = (tc.precondition || "").trim();
        
        formattedSteps = formattedSteps.replace(/(\s+)(\d+\.)(?!\d)/g, '\n$2');
        formattedSteps = formattedSteps.replace(/^\n/, '');
        
        formattedSteps = formattedSteps
            .split('\n')
            .map(line => line.trim().replace(/\.$/, ''))
            .join('\n');

        formattedPrecond = formattedPrecond.replace(/(\s+)(\d+\.)(?!\d)/g, '\n$2');
        formattedPrecond = formattedPrecond.replace(/^\n/, '');
        
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

        return 0; 
    });

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
        if (obj[key] !== undefined) return obj[key];
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
                temperature: 0.3, 
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
  
  // UPDATED STRATEGY: Implemented "Universal Traversal Strategy" and "Matrix Permutation"
  const PHASES = [
      { 
          name: "1. UI/UX Inspection", 
          prompt: `
            Focus strictly on visible UI elements.
            - Check Labels, Placeholders, Icons, Colors, Fonts.
            - Verify alignment and layout consistency.
          `
      },
      { 
          name: "2. Functional Logic (Happy Path)", 
          prompt: `
            Focus on the main business logic and successful workflows.
            - Verify navigation links.
            - Verify successful form submissions.
            - Verify screen transitions.
          `
      },
      { 
          name: "3. Input Validation (Negative Path)", 
          prompt: `
            Focus on constraints and error handling.
            - Check Max/Min length, Required fields, Invalid formats.
            - Check boundary values (Edge cases for numbers/dates).
          `
      },
      { 
          name: "4. State Dynamics & Arithmetic", 
          prompt: `
            1. **Counters**: Verify numbers increase (+1) / decrease (-1).
            2. **Popups**: Verify [Confirm] executes action, [Cancel] closes popup without action.
            3. **Lists**: Verify 0 items, 1 item, Many items behavior.
          `
      },
      { 
          name: "5. Context-Aware Edge Cases", 
          prompt: `
            1. **Transaction Screens**: Test Network disconnect, Refresh, Back button during process.
            2. **Static Screens**: Test simple layout stability on resize (if applicable).
          `
      }
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
  for (let i = 0; i < PHASES.length; i++) {
      const currentPhase = PHASES[i];
      console.log(`[Gemini Loop] Starting ${currentPhase.name} - StartNo: ${currentStartNo}`);

      // Dynamic Phase Prompt Injection
      const loopPrompt = `
      --- COMMAND ---
      CURRENT PHASE: ${currentPhase.name}
      
      Generate Test Cases starting from No.${currentStartNo}.

      ### STRATEGY: CHAIN OF THOUGHT & TRAVERSAL (CRITICAL)

      **Step 1: The "Virtual Finger" Simulation**
      Before generating any TC, simulate a user's finger moving through the content.
      - **IF IMAGE:** Scan strictly from **Top-Left ↘ Bottom-Right** (Z-Pattern).
      - **IF TEXT:** Scan hierarchically: **[Section Title] ↘ [Subtitle] ↘ [Form Input] ↘ [Action Button]**.

      **Step 2: The "Stop & Verify" Rule**
      Do not rush to the submit button. Stop at **EVERY** element your virtual finger touches.
      - **Found a Text Label?** -> Generate TC: "Check text visibility/typo".
      - **Found an Input Field?** -> Generate TCs: "Valid input", "Empty input", "Max length", "Special chars".
      - **Found a List?** -> Generate TCs: "1 item", "Multi items", "Empty list".
      - **Found a Date Picker?** -> Generate TCs: "Past date", "Future date", "Start > End".

      **Step 3: Matrix Permutation (Multi-Angle Verification)**
      Do not generate just one case. Exploit the "State Matrix" for every found element:
      - **Input Fields:** [Empty, Valid, Invalid Type, Max Length, Min Length]
      - **Buttons:** [Active, Disabled, Hover, Double Click]
      - **Checkboxes/Radios:** [Default, Selected, Unselected, Toggle]
      - **Popups:** [Confirm, Cancel, Close(x), Outside Click]
      - **Date/Time:** [Past, Future, Range(Start>End), Invalid Format]

      PHASE INSTRUCTION (Focus Area):
      ${currentPhase.prompt}
      
      CRITICAL RULES:
      1. Analyze the document/image specifically for this Phase.
      2. **Preconditions**: MUST be a numbered list describing STATE.
      3. **Steps**: End sentences with NOUNS (명사형) or IMPERATIVE. **DO NOT end with a period(.).**
      4. **Results**: Use PASSIVE VOICE (~된다).
      5. **Atomicity**: One TC verifies exactly ONE thing.
      
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
               
               const lastTC = currentBatchTCs[currentBatchTCs.length - 1];
               currentStartNo = (lastTC?.no || currentStartNo) + 1;
          }

      } catch (error) {
          console.error(`Error in loop ${i+1}:`, error);
      }
  }

  const finalTestCases = postProcessTestCases(accumulatedTestCases);

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
    
    CRITICAL RULES:
    1. Maintain the "Visual Permutation" rule.
    2. Maintain the "Atomic Rule" (One Result per TC).
    3. **Preconditions**: MUST be a numbered list (1. ... \n2. ...).
    4. **Steps**: End sentences with NOUNS (명사형) or IMPERATIVE. **DO NOT end with a period(.).**
    5. **Results**: Use PASSIVE VOICE (~된다).
    
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
