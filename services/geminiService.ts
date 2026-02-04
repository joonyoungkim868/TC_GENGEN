
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
                    title: { type: Type.STRING, description: "Test Case Title (in Korean). Must be specific." },
                    depth1: { type: Type.STRING },
                    depth2: { type: Type.STRING },
                    depth3: { type: Type.STRING },
                    precondition: { 
                        type: Type.STRING, 
                        description: "Specific Data State required. Must utilize numbered list (1. State A\\n2. State B)." 
                    },
                    steps: { 
                        type: Type.STRING, 
                        description: "Detailed execution path with CONCRETE DATA. Use specific dates, numbers, or strings (e.g., '2024-01-01'). End with Noun (명사형)." 
                    },
                    expectedResult: { 
                        type: Type.STRING, 
                        description: "Exact UI text or System State change. Use Passive Voice (~된다). Include error message content if applicable." 
                    },
                },
                required: ["no", "title", "steps", "expectedResult"] // Enforce required fields
            }
        },
        questions: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
        },
        summary: { type: Type.STRING },
        hasMore: { 
            type: Type.BOOLEAN, 
            description: "Set to TRUE if there are more possible test cases for this phase that haven't been generated yet. Set to FALSE only if exhaustive." 
        }
    }
};

// 1. Bracket-based parser (Standard approach)
const parseViaBrackets = (text: string, result: { testCases: any[], questions: string[], summary: string, hasMore: boolean }) => {
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
                              if (obj.hasMore !== undefined) result.hasMore = obj.hasMore;
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

const recoverTruncatedJson = (text: string): { testCases: any[], questions: string[], summary: string, hasMore: boolean } => {
  const result = {
    testCases: [] as any[],
    questions: [] as string[],
    summary: "",
    hasMore: false
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
    let currentDelay = 3000; 

    while (apiAttempts < MAX_API_RETRIES) {
        try {
            console.log(`[Gemini Request] Attempt ${apiAttempts + 1}`);

            const config: any = {
                systemInstruction: baseSystemInstruction,
                maxOutputTokens: 65536,
                temperature: 0.3, // Slightly higher for creativity in variation, but strictly controlled by schema
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
            
            if (apiAttempts < MAX_API_RETRIES) {
                console.log(`[Backoff] Retrying in ${currentDelay}ms...`);
                await delay(currentDelay);
                currentDelay = currentDelay * 2; 
            }
        }
    }
    throw new Error("Failed to get response from Gemini");
};

// Helper to handle parsing and mapping from Gemini response
const parseResponse = (responseText: string): { tcs: TestCase[], qs: string[], summary: string, hasMore: boolean } => {
    let tcs: TestCase[] = [];
    let qs: string[] = [];
    let summary = "";
    let hasMore = false;

    const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
        const json = JSON.parse(cleanText);
        const rawTcs = json.testCases || json.testcases || [];
        tcs = mapToTestCases(rawTcs);
        qs = json.questions || [];
        summary = json.summary || "";
        hasMore = json.hasMore === true;
    } catch (e) {
        console.warn("JSON Parse failed, attempting recovery...");
        const recovered = recoverTruncatedJson(responseText);
        tcs = mapToTestCases(recovered.testCases);
        qs = recovered.questions;
        summary = recovered.summary;
        hasMore = recovered.hasMore;
    }
    return { tcs, qs, summary, hasMore };
};

export const generateTestCases = async (
  files: UploadedFile[],
  styleFeedback: string
): Promise<{ testCases: TestCase[]; questions: string[]; summary: string }> => {
  const ai = getClient();
  
  const PHASES = [
      { 
          name: "1. Data Integrity & Validation", 
          prompt: `
            **GOAL**: Verify field-level constraints using **Variation Matrix**.
            
            For EVERY input field identified, generate 4 types of cases:
            1. **Valid Data**: Standard, correct input.
            2. **Invalid Data**: Wrong format, special characters, type mismatch.
            3. **Boundary Values**: Min, Max, Min-1, Max+1.
            4. **Empty/Null**: Submit without mandatory fields.
            
            Do NOT group them. Create separate Test Cases for each variation.
          `
      },
      { 
          name: "2. Business Logic & Interdependency", 
          prompt: `
            **GOAL**: Verify relationships between fields.
            
            **CRITICAL**: You must find cases where "Field A affects Field B".
            - Date Logic: Start > End, Same Day, Leap Year.
            - Calculations: Price * Qty = Total.
            - Status Logic: 'Sold Out' items cannot be carted.
            - Permissions: User vs Admin view differences.
            
            Use **Concrete Data** (e.g., "Select 'Electronics' -> 'Laptop' appears").
          `
      },
      { 
          name: "3. Workflow, States & Edge Cases", 
          prompt: `
            **GOAL**: Verify lifecycle and abnormal flows.
            
            - **Lifecycle**: Create -> Read -> Update -> Delete (CRUD).
            - **State Change**: Draft -> Published -> Archived.
            - **Negative Flow**: Back button during loading, Network interrupt.
            - **Double Action**: Click [Save] twice rapidly.
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
      console.log(`[Gemini Loop] Starting ${currentPhase.name}`);

      // ---------------------------------------------------------
      // STEP 1: EXPANSION LOOP (Quantity Generation)
      // ---------------------------------------------------------
      let phaseDraftTCs: TestCase[] = [];
      let phaseQs: string[] = [];
      let hasMore = true;
      let pageCount = 0;
      const MAX_PAGES = 3; // Safety limit to prevent infinite loops (approx 30-45 TCs per phase)

      while (hasMore && pageCount < MAX_PAGES) {
          pageCount++;
          console.log(`   -> Expansion Page ${pageCount} for ${currentPhase.name}`);

          const previousTitles = phaseDraftTCs.map(tc => tc.title).join(", ");
          
          const expansionPrompt = `
          --- COMMAND: STEP 1 (EXPANSION) ---
          CURRENT PHASE: ${currentPhase.name}
          PAGE: ${pageCount}
          
          **TASK**: Generate Test Cases using the strategies below.
          
          **STRATEGY**:
          ${currentPhase.prompt}
          
          **PAGINATION RULE**:
          - If you can think of MORE cases that are NOT in the list below, set "hasMore": true.
          - If you have exhausted ALL possibilities for this phase, set "hasMore": false.
          
          **ALREADY GENERATED (DO NOT DUPLICATE)**:
          ${previousTitles.substring(0, 1000)}...

          Output JSON.
          --- END COMMAND ---
          `;

          try {
              const response = await callGeminiWithRetry(ai, [...baseParts, { text: expansionPrompt }], baseSystemInstruction, true);
              const parsed = parseResponse(response);
              
              if (parsed.tcs.length > 0) {
                  phaseDraftTCs = [...phaseDraftTCs, ...parsed.tcs];
                  phaseQs = [...phaseQs, ...parsed.qs];
              }
              
              hasMore = parsed.hasMore;
              if (parsed.tcs.length === 0) hasMore = false; // Stop if AI returns nothing

          } catch (e) {
              console.error(`Error in Expansion Page ${pageCount}:`, e);
              hasMore = false;
          }
      }

      console.log(`   -> Draft Generated: ${phaseDraftTCs.length} TCs. Starting Verification...`);

      // ---------------------------------------------------------
      // STEP 2: STRICT VERIFICATION (Hallucination Pruning)
      // ---------------------------------------------------------
      if (phaseDraftTCs.length > 0) {
          
          // We send the titles and steps to the "Judge"
          const draftSummary = JSON.stringify(phaseDraftTCs.map(tc => ({ 
              id: tc.id, // Keep ID to map back
              title: tc.title, 
              steps: tc.steps,
              expected: tc.expectedResult 
          })));

          const verificationPrompt = `
          --- COMMAND: STEP 2 (VERIFICATION JUDGE) ---
          
          You are the **Verification Judge**.
          Below is a list of DRAFT Test Cases generated by a junior engineer.
          
          **TASK**:
          1. Cross-reference EACH Test Case with the provided files (Images/Text).
          2. **EVIDENCE CHECK**: Can you find the button, field, or logic described in the source files?
          3. **ACTION**:
             - If VALID (Evidence found): Keep it.
             - If HALLUCINATION (No evidence found): **DELETE IT**. Do not fix it, just drop it.
          
          **OUTPUT**:
          - Return the filtered list of Test Cases.
          - Use the exact same format as input.
          - **Discard** any TC that invents features not in the documents.

          DRAFT LIST TO VERIFY:
          ${draftSummary}

          Output ONLY valid JSON.
          --- END COMMAND ---
          `;

          try {
              const verifyResponse = await callGeminiWithRetry(ai, [...baseParts, { text: verificationPrompt }], baseSystemInstruction, true);
              const verifiedParsed = parseResponse(verifyResponse);
              
              const verifiedTCs = verifiedParsed.tcs;
              console.log(`   -> Verification Complete. Dropped ${phaseDraftTCs.length - verifiedTCs.length} hallucinations.`);

              // Normalize and Add to Accumulator
              const normalized = normalizeTestCases(verifiedTCs);
              
              // Renumbering for this batch to ensure continuity
              const renumbered = normalized.map((tc, idx) => ({
                  ...tc,
                  no: currentStartNo + idx
              }));
              
              if (renumbered.length > 0) {
                  accumulatedTestCases = [...accumulatedTestCases, ...renumbered];
                  accumulatedQuestions = [...accumulatedQuestions, ...phaseQs]; // Keep original questions
                  currentStartNo += renumbered.length;
                  finalSummary += ` [${currentPhase.name}] Generated ${renumbered.length} valid cases.`;
              }

          } catch (e) {
              console.error("Verification failed, falling back to draft (risky but better than empty):", e);
              // Fallback: If verification crashes, use the draft but mark them? Or just use draft.
              // For now, we normalize the draft and use it to avoid data loss.
              const normalized = normalizeTestCases(phaseDraftTCs);
              const renumbered = normalized.map((tc, idx) => ({ ...tc, no: currentStartNo + idx }));
              accumulatedTestCases = [...accumulatedTestCases, ...renumbered];
              currentStartNo += renumbered.length;
          }
      }
  }

  const finalTestCases = postProcessTestCases(accumulatedTestCases);

  return {
    testCases: finalTestCases,
    questions: Array.from(new Set(accumulatedQuestions)),
    summary: finalSummary || `Generated ${finalTestCases.length} Test Cases via Deep Dive Analysis.`
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
    1. **Preconditions**: MUST be a numbered list (1. ... \n2. ...).
    2. **Steps**: Use CONCRETE DATA (e.g., "Enter '2024-01-01'"). End sentences with NOUNS.
    3. **Results**: Use PASSIVE VOICE (~된다). Specify EXACT Error Messages if applicable.
    
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
        const parsed = parseResponse(responseText);
        
        let newTCs = normalizeTestCases(parsed.tcs);
        const finalTestCases = postProcessTestCases(newTCs);

        return {
            testCases: finalTestCases,
            questions: parsed.qs,
            summary: parsed.summary || "Updated based on Q&A."
        };

    } catch (error) {
        console.error("Error updating TCs with QA:", error);
        throw error;
    }
};
