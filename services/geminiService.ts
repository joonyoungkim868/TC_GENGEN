
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
    let currentDelay = 3000; 

    while (apiAttempts < MAX_API_RETRIES) {
        try {
            console.log(`[Gemini Request] Attempt ${apiAttempts + 1}`);

            const config: any = {
                systemInstruction: baseSystemInstruction,
                maxOutputTokens: 65536,
                temperature: 0.2, // Lower temperature for more analytical/strict results
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
const parseResponse = (responseText: string): { tcs: TestCase[], qs: string[], summary: string } => {
    let tcs: TestCase[] = [];
    let qs: string[] = [];
    let summary = "";

    const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
        const json = JSON.parse(cleanText);
        const rawTcs = json.testCases || json.testcases || [];
        tcs = mapToTestCases(rawTcs);
        qs = json.questions || [];
        summary = json.summary || "";
    } catch (e) {
        console.warn("JSON Parse failed, attempting recovery...");
        const recovered = recoverTruncatedJson(responseText);
        tcs = mapToTestCases(recovered.testCases);
        qs = recovered.questions;
        summary = recovered.summary;
    }
    return { tcs, qs, summary };
};

export const generateTestCases = async (
  files: UploadedFile[],
  styleFeedback: string
): Promise<{ testCases: TestCase[]; questions: string[]; summary: string }> => {
  const ai = getClient();
  
  const PHASES = [
      { 
          name: "1. Visual Inspector (UI/UX)", 
          mode: "STANDARD", // Run once
          prompt: `
            **GOAL**: Detect visual anomalies.
            - Scan for **Typos** in labels and guide texts.
            - Verify **Placeholders** are present in empty fields.
            - Check alignment of input boxes and buttons.
            - Verify Icons match their labels.
          `
      },
      { 
          name: "2. Flow Navigator (Transitions)", 
          mode: "DEEP_DIVE", // Run Draft -> Audit -> Expand
          prompt: `
            **GOAL**: Verify screen transitions.
            - Do not just check the current screen. Check where the [Button] takes you.
            - TC Structure: Step [Click Button] -> Expected [New Page Opens].
            - Verify Breadcrumbs or Header Titles update correctly after transition.
          `
      },
      { 
          name: "3. Field Iterator (Input Validation)", 
          mode: "DEEP_DIVE", // Run Draft -> Audit -> Expand
          prompt: `
            **GOAL**: Exhaustive Input Testing (De-bundling).
            - **LOOP**: For EVERY input field found (A, B, C...):
              1. Generate TC: [Field A] - Empty value.
              2. Generate TC: [Field A] - Invalid format (Special chars, etc).
              3. Generate TC: [Field A] - Max length exceeded.
            - **WARNING**: Do NOT group fields. "Check all inputs" is FORBIDDEN.
          `
      },
      { 
          name: "4. Logic Calculator (State & Arithmetic)", 
          mode: "DEEP_DIVE", // Run Draft -> Audit -> Expand
          prompt: `
            **GOAL**: Verify numeric changes and state updates.
            - **FORMULA**: If a list item is added/removed, use formula: **[Before: N] -> [After: N+1]** or **[N-1]**.
            - Explicitly mention the calculation in Expected Result. (e.g., "Count increases from 0 to 1").
            - Verify Pagination (Page 1 -> Page 2).
          `
      },
      { 
          name: "5. Context-Based Stability (Retention)", 
          mode: "STANDARD",
          prompt: `
            **GOAL**: Verify data persistence and safe failures.
            - Test **Browser Refresh (F5)**: Does the form data survive?
            - Test **Back Button**: Can user return to previous state safely?
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
      console.log(`[Gemini Loop] Starting ${currentPhase.name} (Mode: ${currentPhase.mode})`);

      // ---------------------------------------------------------
      // STEP 1: DRAFT (Create initial list)
      // ---------------------------------------------------------
      const draftPrompt = `
      --- COMMAND: STEP 1 (DRAFT) ---
      CURRENT PHASE: ${currentPhase.name}
      START_NO: ${currentStartNo}
      
      **TASK**: Generate an exhaustive list of Test Cases for this phase.
      
      **STRATEGY**:
      1. Iterate through EVERY visible element.
      2. Apply Truth Table (Valid/Invalid/Empty).
      3. Do NOT stop until all elements are covered.
      
      PHASE INSTRUCTION:
      ${currentPhase.prompt}
      
      Output ONLY valid JSON.
      --- END COMMAND ---
      `;

      let phaseTCs: TestCase[] = [];
      let phaseQs: string[] = [];

      try {
          const draftResponse = await callGeminiWithRetry(ai, [...baseParts, { text: draftPrompt }], baseSystemInstruction, true);
          const parsed = parseResponse(draftResponse);
          phaseTCs = parsed.tcs;
          phaseQs = parsed.qs;
          if (parsed.summary) finalSummary += ` [${currentPhase.name}] ${parsed.summary}`;

          // ---------------------------------------------------------
          // STEP 2 & 3: AUDIT & EXPAND (Only for DEEP_DIVE phases)
          // ---------------------------------------------------------
          if (currentPhase.mode === "DEEP_DIVE" && phaseTCs.length > 0) {
              
              // We minimize the draft list to save tokens, sending only key fields for review
              const draftSummary = JSON.stringify(phaseTCs.map(tc => ({ no: tc.no, title: tc.title, steps: tc.steps, expected: tc.expectedResult })));

              const auditPrompt = `
              --- COMMAND: STEP 2 (AUDIT & EXPAND) ---
              CURRENT PHASE: ${currentPhase.name}
              
              You are now the **Lead Auditor**.
              Review the "Draft Test Cases" provided below against the visual document.

              **TASK A: FACT CHECK (Quality Control)**
              - **Verify Existence**: Does the element mentioned in the TC *actually exist* in the image/text? 
                - If NO, discard it.
                - If text labels (Button names) are wrong, correct them.
              - **Verify Logic**: Is the expected result realistic based on the provided UI?

              **TASK B: GAP ANALYSIS (Quantity Expansion)**
              - Look for "Blind Spots" that the Draft missed.
              - Are there other buttons, links, or inputs in the image that were ignored?
              - Are there negative cases (Error handling) missing?
              
              **FINAL OUTPUT**:
              - Regenerate the **FULL, CLEAN LIST**.
              - Include the valid/corrected TCs from the Draft.
              - Appending NEW TCs for the missing gaps found in Task B.
              - Start numbering from ${currentStartNo}.

              DRAFT TEST CASES (For Review):
              ${draftSummary}

              Output ONLY valid JSON.
              --- END COMMAND ---
              `;

              console.log(`[Gemini Loop] Deep Dive Audit for ${currentPhase.name}...`);
              const auditResponse = await callGeminiWithRetry(ai, [...baseParts, { text: auditPrompt }], baseSystemInstruction, true);
              const audited = parseResponse(auditResponse);
              
              // If audit returns results, trust the Auditor. If it fails/returns empty, fallback to Draft.
              if (audited.tcs.length > 0) {
                  console.log(`[Gemini Loop] Audit complete. TC Count: ${phaseTCs.length} -> ${audited.tcs.length}`);
                  phaseTCs = audited.tcs; // Replace draft with audited version
                  phaseQs = [...phaseQs, ...audited.qs]; // Accumulate questions
              } else {
                  console.warn(`[Gemini Loop] Audit returned 0 TCs. Reverting to Draft.`);
              }
          }

          // Normalize and Append
          phaseTCs = normalizeTestCases(phaseTCs);
          if (phaseTCs.length > 0) {
               accumulatedTestCases = [...accumulatedTestCases, ...phaseTCs];
               accumulatedQuestions = [...accumulatedQuestions, ...phaseQs];
               
               const lastTC = phaseTCs[phaseTCs.length - 1];
               currentStartNo = (lastTC?.no || currentStartNo) + 1;
          }

      } catch (error) {
          console.error(`Error in loop ${currentPhase.name}:`, error);
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
