/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import loader from '@monaco-editor/loader';
import markdownit from 'markdown-it';
import {sanitizeHtml} from 'safevalues';
import {setAnchorHref, setElementInnerHtml, windowOpen} from 'safevalues/dom';
import Sortable, {SortableEvent} from 'sortablejs';
import { GoogleGenAI, Type } from "@google/genai";
import * as monacoEditor from 'monaco-editor';

declare global {
  interface Window {
    THREE: any;
  }
}

interface MarkdownItInstance {
  render: (markdown: string) => string;
}

// Monaco will be loaded dynamically
// tslint:disable-next-line:no-any - we need to load the library first.
let monaco: typeof monacoEditor | undefined;
// tslint:disable-next-line:no-any - we need to load the library first.
type MonacoEditorInstance = monacoEditor.editor.IStandaloneCodeEditor;
interface AppMetadata {
  name?: string;
  title?: string;
}

interface CookbookData {
  notebookCode: string;
}

let appMetadata: AppMetadata = {};
let cookbookMetadata: CookbookData = { notebookCode: '' };
let rawLink = '';

function blobToRaw(blobUrl: string) {
  if (!blobUrl) return '';
  const pattern =
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/;
  const match = blobUrl.match(pattern);

  if (!match) {
    return blobUrl; // Fallback if not a github blob url
  }

  const [, repo, branch, filePath] = match;
  return `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
}

const md: MarkdownItInstance = (
  markdownit as unknown as (
    options?: Record<string, unknown>,
  ) => MarkdownItInstance
)({
  html: true, // This allows HTML tags from markdown, so sanitizeHtml is important for md.render() output
  linkify: true,
  typographer: true,
});

let rawLink_placeholder = ''; // temporary placeholder

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    downloadNotebook();
  }
});

document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (a?.href) {
    e.preventDefault();
    windowOpen(window, a.href, '_blank', 'noopener');
  }
});

type Output =
  | {type: 'log' | 'error'; data: string}
  | {type: 'image'; data: string; mime: string};

interface Cell {
  id: string;
  type: 'js' | 'md';
  mode?: 'edit' | 'render';
  outputs: Output[];
  isOutputVisible?: boolean;
  isExecuted?: boolean;
  lastExecutedContent?: string;
}

const notebook = document.getElementById('notebook') as HTMLDivElement;
let cellCounter = 0;
const cells: Cell[] = [];
const monacoInstances: {[key: string]: MonacoEditorInstance} = {};
let cellClipboard: {cellData: Cell; code: string} | null = null;
let focusedCellId: string | null = null;

// Agent State
const agentChatHistory = document.getElementById('agent-chat-history') as HTMLDivElement;
const agentInput = document.getElementById('agent-input') as HTMLInputElement;
const agentSendBtn = document.getElementById('agent-send-btn') as HTMLButtonElement;

const viewCodeBtn = document.getElementById('view-code-btn') as HTMLButtonElement;
const viewPreviewBtn = document.getElementById('view-preview-btn') as HTMLButtonElement;
const viewHistoryBtn = document.getElementById('view-history-btn') as HTMLButtonElement;
const previewContainer = document.getElementById('preview-container') as HTMLDivElement;
const previewContent = document.getElementById('preview-content') as HTMLDivElement;
const refreshPreviewBtn = document.getElementById('refresh-preview-btn') as HTMLButtonElement;
const historyContainer = document.getElementById('history-container') as HTMLDivElement;
const historyList = document.getElementById('history-list') as HTMLDivElement;
const commitBtn = document.getElementById('commit-btn') as HTMLButtonElement;
const gitSyncBtn = document.getElementById('git-sync-btn') as HTMLButtonElement;
const clearHistoryBtn = document.getElementById('clear-history-btn') as HTMLButtonElement;
const historyCommitBtn = document.getElementById('history-commit-btn') as HTMLButtonElement;

interface Version {
    id: string;
    timestamp: number;
    label: string;
    cells: {
        type: 'js' | 'md';
        code: string;
        outputs: Output[];
    }[];
}

let versions: Version[] = [];

function loadVersions() {
    const saved = localStorage.getItem('eburon_versions');
    if (saved) {
        try {
            versions = JSON.parse(saved);
            updateHistoryUI();
        } catch (e) {
            console.error("Failed to load versions", e);
        }
    }
}

function saveVersion(label: string = 'Manual Commit', silent: boolean = false) {
    const version: Version = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        label,
        cells: cells.map(c => ({
            type: c.type,
            code: monacoInstances[c.id]?.getValue() || '',
            outputs: [...c.outputs]
        }))
    };
    versions.unshift(version);
    localStorage.setItem('eburon_versions', JSON.stringify(versions));
    updateHistoryUI();
    if (!silent) {
        addAgentMessage(`Version "${label}" saved successfully.`, 'system');
    }
}

async function restoreVersion(versionId: string) {
    const version = versions.find(v => v.id === versionId);
    if (!version) return;

    if (!confirm(`Are you sure you want to restore to version "${version.label}"? Current unsaved changes will be lost.`)) {
        return;
    }

    // Clear current notebook
    const cellIds = cells.map(c => c.id);
    cellIds.forEach(id => deleteCell(id));
    cells.length = 0;
    cellCounter = 0;

    // Restore cells
    for (const cellData of version.cells) {
        await addCell(cellData.code, cellData.type, cellData.type === 'md', cellData.outputs);
    }

    addAgentMessage(`Restored to version: ${version.label}`, 'system');
    viewCodeBtn.click(); // Switch back to notebook view
}

function deleteVersion(versionId: string) {
    versions = versions.filter(v => v.id !== versionId);
    localStorage.setItem('eburon_versions', JSON.stringify(versions));
    updateHistoryUI();
}

function clearHistory() {
    if (confirm("Are you sure you want to clear all version history?")) {
        versions = [];
        localStorage.removeItem('eburon_versions');
        updateHistoryUI();
    }
}

function updateHistoryUI() {
    if (!historyList) return;
    
    if (versions.length === 0) {
        setElementInnerHtml(historyList, sanitizeHtml('<div class="empty-history">No versions saved yet. Click "Commit" to save the current state.</div>'));
        return;
    }

    let html = '';
    versions.forEach(v => {
        const date = new Date(v.timestamp).toLocaleString();
        html += `
            <div class="history-item">
                <div class="history-item-info">
                    <div class="history-item-label">${v.label}</div>
                    <div class="history-item-meta">${date} • ${v.cells.length} cells</div>
                </div>
                <div class="history-item-actions">
                    <button class="btn-restore" onclick="restoreVersion('${v.id}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 2v6h6M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>
                        Restore
                    </button>
                    <button class="btn-delete-version" onclick="deleteVersion('${v.id}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
        `;
    });
    setElementInnerHtml(historyList, sanitizeHtml(html));
}

const newNotebookBtn = document.getElementById('new-notebook-btn') as HTMLButtonElement;

newNotebookBtn.addEventListener('click', () => {
    if (cells.length > 0 && confirm("Save current notebook as a version before starting a new one?")) {
        saveVersion("Pre-New Notebook Snapshot");
    }
    
    if (confirm("Are you sure you want to start a new notebook? All current cells will be deleted.")) {
        const cellIds = cells.map(c => c.id);
        cellIds.forEach(id => deleteCell(id));
        cells.length = 0;
        cellCounter = 0;
        addCell('', 'js');
        addAgentMessage("New notebook started.", "system");
    }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

function addAgentMessage(text: string, type: 'system' | 'user' | 'thinking') {
  const msgDiv = document.createElement('div');
  msgDiv.className = `agent-message ${type}`;
  if (type === 'thinking') {
    msgDiv.id = 'agent-thinking-msg';
  }
  
  // Use markdown to render agent messages
  if (type !== 'thinking') {
    setElementInnerHtml(msgDiv, sanitizeHtml(md.render(text)));
  } else {
    msgDiv.textContent = text;
  }
  
  agentChatHistory.appendChild(msgDiv);
  agentChatHistory.scrollTop = agentChatHistory.scrollHeight;
  return msgDiv;
}

async function handleAgentRequest() {
  const goal = agentInput.value.trim();
  if (!goal) return;

  agentInput.value = '';
  addAgentMessage(goal, 'user');
  
  const thinkingMsg = addAgentMessage('Eburon is synthesizing architecture...', 'thinking');

  try {
    const model = ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [
        {
          role: "user",
          parts: [{ text: `You are Eburon Codemax, a world-class autonomous AI coding agent. 
          Your goal is to help the user build sophisticated web applications in this interactive notebook environment.
          
          CAPABILITIES:
          1. Add cells (js or md) to the notebook.
          2. Run cells to execute code.
          3. Modify existing cells by replacing their content.
          
          INTENT PARSING RULES:
          - If the user wants to build a feature, create a plan first, then add the necessary cells.
          - Use Markdown cells for documentation, explanations, and architecture diagrams.
          - Use JavaScript cells for logic, UI components (rendering to the DOM), and data processing.
          - When creating UI, target the 'preview-content' element or use the globally available 'previewContent' variable if you want it to show up in the Preview tab.
          - You can save versions of the notebook using 'save_notebook_version' if you've made significant progress.
          
          Current notebook state:
          ${cells.map(c => `[ID: ${c.id}, Type: ${c.type}] Content: ${monacoInstances[c.id]?.getValue() || ''}`).join('\n---\n')}
          
          User Goal: ${goal}
          
          Respond with a concise plan and then use the provided tools to implement it.` }]
        }
      ],
      config: {
        tools: [{
          functionDeclarations: [
            {
              name: "add_notebook_cell",
              description: "Adds a new cell to the notebook.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  code: { type: Type.STRING, description: "The content of the cell." },
                  type: { type: Type.STRING, enum: ["js", "md"], description: "The type of the cell." },
                  run: { type: Type.BOOLEAN, description: "Whether to run the cell immediately after adding it." }
                },
                required: ["code", "type"]
              }
            },
            {
              name: "modify_notebook_cell",
              description: "Modifies an existing cell in the notebook.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  cellId: { type: Type.STRING, description: "The ID of the cell to modify (e.g., 'cell0')." },
                  code: { type: Type.STRING, description: "The new content for the cell." },
                  run: { type: Type.BOOLEAN, description: "Whether to run the cell after modifying it." }
                },
                required: ["cellId", "code"]
              }
            },
            {
              name: "run_all_cells",
              description: "Runs all JavaScript cells in the notebook.",
              parameters: { type: Type.OBJECT, properties: {} }
            },
            {
              name: "save_notebook_version",
              description: "Saves a named version of the current notebook state.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING, description: "A descriptive label for this version." }
                },
                required: ["label"]
              }
            }
          ]
        }]
      }
    });

    const response = await model;
    thinkingMsg.remove();

    if (response.text) {
      addAgentMessage(response.text, 'system');
    }

    const functionCalls = response.functionCalls;
    if (functionCalls) {
      for (const call of functionCalls) {
        if (call.name === "add_notebook_cell") {
          const args = call.args as { code: string, type: 'js' | 'md', run?: boolean };
          await addCell(args.code, args.type);
          if (args.run && args.type === 'js') {
            const lastCell = cells[cells.length - 1];
            await runCell(lastCell.id);
          }
        } else if (call.name === "modify_notebook_cell") {
          const args = call.args as { cellId: string, code: string, run?: boolean };
          const editor = monacoInstances[args.cellId];
          if (editor) {
            editor.setValue(args.code);
            if (args.run) await runCell(args.cellId);
          }
        } else if (call.name === "run_all_cells") {
          await runAllCells();
        } else if (call.name === "save_notebook_version") {
          const args = call.args as { label: string };
          saveVersion(args.label);
        }
      }
    }
    
    // Auto-save version after agent changes
    saveVersion(`Agent: ${goal.substring(0, 30)}${goal.length > 30 ? '...' : ''}`, true);
    
  } catch (error) {
    thinkingMsg.remove();
    addAgentMessage(`Error: ${error instanceof Error ? error.message : String(error)}`, 'system');
  }
}

agentSendBtn.addEventListener('click', handleAgentRequest);
agentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleAgentRequest();
  }
});

// View Toggles
viewCodeBtn.addEventListener('click', () => {
    viewCodeBtn.classList.add('active');
    viewPreviewBtn.classList.remove('active');
    viewHistoryBtn.classList.remove('active');
    notebook.classList.add('active');
    previewContainer.style.display = 'none';
    historyContainer.style.display = 'none';
});

viewPreviewBtn.addEventListener('click', () => {
    viewPreviewBtn.classList.add('active');
    viewCodeBtn.classList.remove('active');
    viewHistoryBtn.classList.remove('active');
    notebook.classList.remove('active');
    previewContainer.style.display = 'flex';
    historyContainer.style.display = 'none';
    updatePreview();
});

viewHistoryBtn.addEventListener('click', () => {
    viewHistoryBtn.classList.add('active');
    viewCodeBtn.classList.remove('active');
    viewPreviewBtn.classList.remove('active');
    notebook.classList.remove('active');
    previewContainer.style.display = 'none';
    historyContainer.style.display = 'flex';
    updateHistoryUI();
});

commitBtn.addEventListener('click', () => {
    const label = prompt("Enter a label for this version:", `Version ${versions.length + 1}`);
    if (label !== null) {
        saveVersion(label);
    }
});

historyCommitBtn.addEventListener('click', () => {
    const label = prompt("Enter a label for this version:", `Version ${versions.length + 1}`);
    if (label !== null) {
        saveVersion(label);
    }
});

gitSyncBtn.addEventListener('click', () => {
    const content = generateNotebookContent();
    const blob = new Blob([content], {type: 'text/javascript'});
    const url = URL.createObjectURL(blob);
    
    const instructions = `
To sync with Git:
1. Download the current notebook.
2. Move it to your local git repository.
3. Run: 
   git add notebook.js
   git commit -m "Sync from Eburon Codemax"
   git push

Would you like to download the notebook now?`;
    
    if (confirm(instructions)) {
        const a = document.createElement('a');
        setAnchorHref(a, url);
        a.download = 'notebook.js';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});

clearHistoryBtn.addEventListener('click', clearHistory);

function updatePreview() {
    // Clear preview
    setElementInnerHtml(previewContent, sanitizeHtml(''));
    
    // We can't easily "re-run" all cells into the preview div without side effects
    // But we can encourage the agent to use a specific container.
    // For now, let's just show the outputs of all cells if they are HTML-ish
    // or provide a clean slate for the agent to render into.
    console.log("Preview updated. The agent should render into #preview-content");
}

refreshPreviewBtn.addEventListener('click', updatePreview);

// Three.js Background Logic
function initThreeJS() {
    const THREE = window.THREE;
    if (!THREE) return;

    const container = document.getElementById('three-canvas-container');
    if (!container) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070a, 0.05);

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 15;
    camera.position.y = 5;
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const createParticleTexture = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.2, 'rgba(99, 102, 241, 0.8)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 32, 32);
        return new THREE.CanvasTexture(canvas);
    };

    const particlesGeo = new THREE.BufferGeometry();
    const particlesCount = 800;
    const posArray = new Float32Array(particlesCount * 3);
    const velocities: any[] = [];

    for(let i = 0; i < particlesCount * 3; i+=3) {
        posArray[i] = (Math.random() - 0.5) * 40;
        posArray[i+1] = (Math.random() - 0.5) * 40;
        posArray[i+2] = (Math.random() - 0.5) * 40;
        velocities.push({ y: Math.random() * 0.02 + 0.01, x: (Math.random() - 0.5) * 0.01 });
    }

    particlesGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMat = new THREE.PointsMaterial({
        size: 0.4,
        map: createParticleTexture(),
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const particlesMesh = new THREE.Points(particlesGeo, particlesMat);
    scene.add(particlesMesh);

    const animate = () => {
        requestAnimationFrame(animate);
        const positions = particlesGeo.attributes.position.array as Float32Array;
        for(let i = 0; i < particlesCount; i++) {
            const i3 = i * 3;
            positions[i3 + 1] += velocities[i].y;
            positions[i3] += velocities[i].x;
            if(positions[i3 + 1] > 20) positions[i3 + 1] = -20;
        }
        particlesGeo.attributes.position.needsUpdate = true;
        particlesMesh.rotation.y += 0.001;
        renderer.render(scene, camera);
    };

    animate();
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function renderOutputs(outputDiv: HTMLElement, outputs: Output[]) {
  let outputHtml = '';

  outputs.forEach((output) => {
    switch (output.type) {
      case 'log':
        // md.render(output.data) produces HTML. Sanitize it.
        const sanitizedLogContent = sanitizeHtml(md.render(output.data));
        outputHtml += `<div class="console-log">${sanitizedLogContent.toString()}</div>`;
        break;
      case 'error':
        // Escape the error data to prevent XSS
        const escapedErrorData = String(output.data).replace(
          /[<>&"']/g,
          (match) => {
            const escapeMap: {[key: string]: string} = {
              '<': '&lt;',
              '>': '&gt;',
              '&': '&amp;',
              '"': '&quot;',
              "'": '&#x27;',
            };
            return escapeMap[match] || match;
          },
        );
        outputHtml += `<div class="console-error">ERROR: ${escapedErrorData}</div>`;
        break;
      case 'image':
        const imageSrc =
          output.data.startsWith('data:') ||
          output.data.startsWith('http') ||
          output.data.startsWith('./')
            ? output.data
            : `data:${output.mime};base64,${output.data}`;
        // Escape the src attribute to prevent XSS
        const escapedSrc = imageSrc.replace(/[<>"']/g, (match) => {
          const escapeMap: {[key: string]: string} = {
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
          };
          return escapeMap[match] || match;
        });
        outputHtml += `<img src="${escapedSrc}" style="max-width: 100%; display: block; margin: 0.5em 0;" />`;
        break;
      default:
        console.error('Unexpected output type:', output);
        break;
    }
  });

  setElementInnerHtml(outputDiv, sanitizeHtml(outputHtml));
}

function parseNotebookFile(content: string) {
  const lines = content.split('\n');
  const cellsData: Array<{
    type: 'js' | 'md';
    code: string;
    mode?: string;
    outputs?: Output[];
  }> = [];
  let jsCodeLines: string[] = [];
  let mdContent = '';
  let outputContent = '';
  let inCodeBlock = false;
  let inMdBlock = false;
  let inOutputBlock = false;
  let mdMode = 'edit';

  const addJsCell = () => {
    if (jsCodeLines.length > 0) {
      cellsData.push({
        type: 'js',
        code: jsCodeLines.join('\n').trim(),
        outputs: [],
      });
      jsCodeLines = [];
    }
  };

  const addMdCell = () => {
    if (mdContent.trim()) {
      cellsData.push({type: 'md', code: mdContent.trim(), mode: mdMode});
      mdContent = '';
    }
  };

  const addOutput = () => {
    if (outputContent.trim() && cellsData.length > 0) {
      const lastJsCell = [...cellsData].reverse().find((c) => c.type === 'js');
      if (lastJsCell) {
        if (!lastJsCell.outputs) lastJsCell.outputs = [];
        lastJsCell.outputs.push({type: 'log', data: outputContent.trim()});
      }
      outputContent = '';
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (trimmed === '// [CODE STARTS]') {
      addMdCell();
      addOutput();
      inCodeBlock = true;
      inMdBlock = inOutputBlock = false;
      return;
    }

    if (trimmed === '// [CODE ENDS]') {
      addJsCell();
      inCodeBlock = false;
      return;
    }

    if (trimmed.startsWith('/* Markdown')) {
      addJsCell();
      addOutput();
      mdMode = trimmed.includes('(render)') ? 'render' : 'edit';
      inMdBlock = true;
      inCodeBlock = inOutputBlock = false;
      return;
    }

    if (trimmed.startsWith('/* Output')) {
      addJsCell();
      addMdCell();
      inOutputBlock = true;
      inCodeBlock = inMdBlock = false;
      return;
    }

    if (trimmed.endsWith('*/')) {
      const contentLine = line.replace(/\*\/\s*$/, '').trim();
      if (contentLine) {
        if (inMdBlock) mdContent += (mdContent ? '\n' : '') + contentLine;
        else if (inOutputBlock) {
          outputContent += (outputContent ? '\n' : '') + contentLine;
        }
      }
      if (inMdBlock) addMdCell();
      else if (inOutputBlock) addOutput();
      inMdBlock = inOutputBlock = false;
      return;
    }

    if (inCodeBlock) jsCodeLines.push(line);
    else if (inMdBlock) mdContent += (mdContent ? '\n' : '') + line;
    else if (inOutputBlock) outputContent += (outputContent ? '\n' : '') + line;
  });

  addJsCell();
  addMdCell();
  addOutput();

  return cellsData;
}

function updateOutputToggle(
  cellId: string,
  isVisible: boolean,
  hasOutput = true,
) {
  const outputDiv = document.getElementById(`${cellId}_output`);
  const outputToggle = outputDiv?.previousElementSibling as HTMLElement;
  const cell = cells.find((c) => c.id === cellId);

  if (outputDiv && outputToggle && cell) {
    if (cell.type === 'md') {
      outputToggle.style.display = 'none';
      return;
    }

    if (hasOutput) {
      outputDiv.style.display = isVisible ? '' : 'none';
      const icon = outputToggle.querySelector('i');
      if (icon) {
        icon.className = `fa-solid ${isVisible ? 'fa-chevron-down' : 'fa-chevron-up'}`;
      }
      outputToggle.style.display = 'flex';
    } else {
      outputToggle.style.display = 'none';
      outputDiv.style.display = 'none';
    }
  }
}

async function addCell(
  code = '',
  type: 'js' | 'md' = 'js',
  preRender = false,
  outputs: Output[] = [],
  index?: number,
) {
  // Monaco is already imported, no need to await
  const cellId = `cell${cellCounter++}`;
  const cellDiv = document.createElement('div');

  cellDiv.className = 'cell';
  cellDiv.id = `cell-container-${cellId}`;
  cellDiv.dataset.cellId = cellId;

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '☰';

  const executionStatus = document.createElement('div');
  executionStatus.className = 'execution-status';
  const checkIcon = document.createElement('i');
  checkIcon.className = 'fa fa-check';
  checkIcon.setAttribute('aria-hidden', 'true');
  executionStatus.appendChild(checkIcon);

  if (type === 'md') {
    executionStatus.style.display = 'none';
  }

  const hoverMenu = document.createElement('div');
  hoverMenu.className = 'cell-hover-menu';

  const runButtonTitle = type === 'md' ? 'Render Markdown' : 'Run Code';
  const runButtonIconClass = type === 'md' ? 'fa-check-double' : 'fa-play';

  const createHoverButton = (
    title: string,
    iconClass: string,
    clickHandler: (e: MouseEvent) => void,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.title = title;
    button.addEventListener('click', clickHandler);
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;
    button.appendChild(icon);
    return button;
  };

  hoverMenu.appendChild(
    createHoverButton(runButtonTitle, runButtonIconClass, () =>
      runCell(cellId),
    ),
  );
  hoverMenu.appendChild(
    createHoverButton('Move Cell Up', 'fa-arrow-up', () =>
      moveCell(cellId, 'up'),
    ),
  );
  hoverMenu.appendChild(
    createHoverButton('Move Cell Down', 'fa-arrow-down', () =>
      moveCell(cellId, 'down'),
    ),
  );
  hoverMenu.appendChild(
    createHoverButton('Delete Cell', 'fa-trash-alt', () => deleteCell(cellId)),
  );

  const editorContainer = document.createElement('div');
  editorContainer.id = `${cellId}_editor_container`;
  editorContainer.className = 'editor-container';

  const outputToggle = document.createElement('div');
  outputToggle.className = 'output-toggle';
  outputToggle.appendChild(document.createTextNode('Output '));
  const chevronIcon = document.createElement('i');
  chevronIcon.className = 'fa-solid fa-chevron-down';
  outputToggle.appendChild(chevronIcon);
  outputToggle.style.display = 'none';

  const outputDiv = document.createElement('div');
  outputDiv.className = 'output';
  outputDiv.id = `${cellId}_output`;
  if (type === 'md') outputDiv.style.display = 'none';

  cellDiv.appendChild(dragHandle);
  cellDiv.appendChild(executionStatus);
  cellDiv.appendChild(hoverMenu);
  cellDiv.appendChild(editorContainer);
  cellDiv.appendChild(outputToggle);
  cellDiv.appendChild(outputDiv);

  outputToggle.addEventListener('click', () => {
    const cell = cells.find((c) => c.id === cellId);
    if (cell && cell.type === 'js' && cell.outputs.length > 0) {
      cell.isOutputVisible = !cell.isOutputVisible;
      updateOutputToggle(cellId, cell.isOutputVisible, true);
    }
  });

  if (notebook) {
    if (index !== undefined) {
      const cellElements = Array.from(notebook.getElementsByClassName('cell'));
      const anchorElement = cellElements[index] as HTMLElement | undefined;
      notebook.insertBefore(cellDiv, anchorElement || null);
    } else {
      notebook.appendChild(cellDiv);
    }
  }

  const editorInstance = monaco.editor.create(editorContainer, {
    value: code,
    language: type === 'md' ? 'markdown' : 'javascript',
    theme: 'custom-dark',
    automaticLayout: true,
    minimap: {enabled: false},
    fontSize: 14,
    wordWrap: 'on',
    lineNumbers: 'off',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    contextmenu: true,
    scrollbar: {vertical: 'hidden', handleMouseWheel: false},
  });

  monacoInstances[cellId] = editorInstance;

  editorInstance.onDidFocusEditorText(() => {
    focusedCellId = cellId;
  });

  editorInstance.onDidChangeModelContent(() => {
    const currentContent = editorInstance.getValue();
    if (checkContentChanged(cellId, currentContent)) {
      markCellAsUnexecuted(cellId);
    }
  });

  const newCellData: Cell = {
    id: cellId,
    type,
    mode: type === 'md' ? 'edit' : undefined,
    outputs,
    isOutputVisible: type === 'js' ? outputs.length > 0 : preRender,
  };

  if (index !== undefined) {
    cells.splice(index, 0, newCellData);
  } else {
    cells.push(newCellData);
  }

  const hasInitialOutput = type === 'js' && outputs.length > 0;
  updateOutputToggle(
    cellId,
    newCellData.isOutputVisible || false,
    hasInitialOutput,
  );

  editorInstance.onDidContentSizeChange(() => {
    const contentHeight = editorInstance.getContentHeight();
    const lineHeight = editorInstance
      .getOptions()
      .get(monaco.editor.EditorOption.lineHeight) as number;
    const newHeight = Math.max(lineHeight * 5, contentHeight);
    editorContainer.style.height = `${newHeight}px`;
    editorInstance.layout({
      width: editorContainer.clientWidth,
      height: newHeight,
    });
  });

  if (type === 'md') {
    outputDiv.addEventListener('dblclick', () => {
      const cell = cells.find((c) => c.id === cellId);
      if (cell && cell.mode === 'render') {
        runCell(cellId);
      }
    });

    outputDiv.style.cursor = preRender ? 'text' : 'default';
    if (preRender) {
      outputDiv.title = 'Double-click to edit';
    }
  }

  if (type === 'md' && preRender) {
    setTimeout(() => runCell(cellId), 0);
  }

  if (type === 'js' && outputs.length > 0) {
    renderOutputs(outputDiv, outputs);
  }
}

function deleteCell(cellId: string) {
  const idx = cells.findIndex((cell) => cell.id === cellId);
  if (idx !== -1) cells.splice(idx, 1);

  document.getElementById(`cell-container-${cellId}`)?.remove();

  if (monacoInstances[cellId]) {
    monacoInstances[cellId].dispose();
    delete monacoInstances[cellId];
  }
}

function generateNotebookContent() {
  let content = '';

  cells.forEach((cell) => {
    const editor = monacoInstances[cell.id];
    const code = editor ? editor.getValue() : '';

    if (cell.type === 'md') {
      const marker =
        cell.mode === 'render' ? '/* Markdown (render)' : '/* Markdown';
      content += `${marker}\n${code}\n*/\n\n`;
    } else {
      content += `// [CODE STARTS]\n${code}\n// [CODE ENDS]\n\n`;

      if (cell.outputs?.length > 0) {
        content += '/* Output Sample\n\n';
        cell.outputs.forEach((output) => {
          if (output.type === 'image') {
            const imgSrc = output.data.startsWith('data:')
              ? output.data
              : `data:${output.mime};base64,${output.data}`;
            // Sanitize image src before including in download content
            const sanitizedSrc = imgSrc.replace(/[<>"']/g, '');
            content += `<img src="${sanitizedSrc}" style="height:auto; width:100%;" />\n\n`;
          } else {
            // Sanitize output data to prevent HTML injection in download content
            const sanitizedOutput = String(output.data).replace(
              /[<>&"']/g,
              (match) => {
                const escapeMap: {[key: string]: string} = {
                  '<': '&lt;',
                  '>': '&gt;',
                  '&': '&amp;',
                  '"': '&quot;',
                  "'": '&#x27;',
                };
                return escapeMap[match] || match;
              },
            );
            content += `${sanitizedOutput}\n\n`;
          }
        });
        content += '*/\n\n';
      }
    }
  });

  return content.trim();
}

async function downloadNotebook() {
  const content = generateNotebookContent();
  const blob = new Blob([content], {type: 'text/javascript'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  setAnchorHref(a, url);
  a.download = 'notebook.js';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function runAllCells() {
  for (const cell of cells) {
    if (cell.type === 'md') {
      continue;
    }
    await runCell(cell.id);
  }
}

const persistentScope: Record<string, unknown> = {};

async function runCell(cellId: string) {
  const cell = cells.find((c) => c.id === cellId);
  const editor = monacoInstances[cellId];
  const outputDiv = document.getElementById(
    `${cellId}_output`,
  ) as HTMLDivElement;
  const editorContainer = document.getElementById(
    `${cellId}_editor_container`,
  ) as HTMLDivElement;
  const cellElement = document.getElementById(`cell-container-${cellId}`);

  if (!cell || !editor || !outputDiv || !editorContainer || !cellElement) {
    console.error(`Could not run cell ${cellId}: missing dependencies`);
    return;
  }

  const code = editor.getValue();

  if (cell.type === 'md') {
    if (cell.mode === 'edit') {
      setElementInnerHtml(outputDiv, sanitizeHtml(md.render(code)));
      outputDiv.style.display = '';
      outputDiv.style.cursor = 'text';
      outputDiv.title = 'Double-click to edit';
      editorContainer.style.display = 'none';
      cellElement.classList.add('rendered-md');
      cell.mode = 'render';
      cell.isOutputVisible = true;
      updateOutputToggle(cellId, true, true);
    } else {
      outputDiv.style.display = 'none';
      outputDiv.style.cursor = 'default';
      outputDiv.title = '';
      editorContainer.style.display = '';
      cellElement.classList.remove('rendered-md');
      cell.mode = 'edit';
      cell.isOutputVisible = false;
      updateOutputToggle(cellId, false, true);
      editor.layout();
      editor.focus();
    }
    return;
  }

  setElementInnerHtml(outputDiv, sanitizeHtml(''));
  cell.outputs = [];

  const showOutput = () => {
    cell.isOutputVisible = true;
    updateOutputToggle(cellId, true, true);
    renderOutputs(outputDiv, cell.outputs);
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      const text = args
        .map((a) =>
          typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a),
        )
        .join(' ');
      cell.outputs.push({type: 'log', data: text});
      showOutput();
    },
    error: (...args: unknown[]) => {
      cell.outputs.push({type: 'error', data: args.join(' ')});
      showOutput();
    },
    image: (base64: string, mime = 'image/png') => {
      cell.outputs.push({type: 'image', data: base64, mime});
      showOutput();
    },
  };

  // Create a safe scope for the cell to avoid pollution of the global scope
  const cellScope: Record<string, unknown> = {};

  // Create AsyncFunction constructor without unsafe member access
  const AsyncFunction = (async () => {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction(
    'console',
    'fetch',
    'persistentScope',
    'cellScope',
    'previewContent',
    `
    try {
      ${code}
    } catch (e) {
      console.error(e);
    }
  `,
  );

  try {
    await fn(
      sandboxConsole,
      window.fetch.bind(window),
      persistentScope,
      cellScope,
      previewContent,
    );
    markCellAsExecuted(cellId, code);
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    sandboxConsole.error('Uncaught:', errorMessage);
    markCellAsExecuted(cellId, code);
  }
}

function moveCell(cellId: string, direction: 'up' | 'down') {
  const cellIndex = cells.findIndex((c) => c.id === cellId);
  if (cellIndex === -1) return;

  const newIndex = direction === 'up' ? cellIndex - 1 : cellIndex + 1;
  if (newIndex < 0 || newIndex >= cells.length) return;

  const [movedCell] = cells.splice(cellIndex, 1);
  cells.splice(newIndex, 0, movedCell);

  const cellElement = document.getElementById(`cell-container-${cellId}`);
  const siblingElement = notebook?.children[newIndex] as
    | HTMLElement
    | undefined;

  if (notebook && cellElement) {
    if (direction === 'up') {
      notebook.insertBefore(cellElement, siblingElement || null);
    } else {
      notebook.insertBefore(cellElement, siblingElement?.nextSibling || null);
    }
  }
}

function restartKernel() {
  if (
    !confirm(
      'Are you sure you want to restart the kernel? All variables will be lost.',
    )
  ) {
    return;
  }
  for (const key in persistentScope) {
    if (Object.prototype.hasOwnProperty.call(persistentScope, key)) {
      delete persistentScope[key];
    }
  }
  cells.forEach((cell) => {
    if (cell.type === 'js') {
      cell.outputs = [];
      const outputDiv = document.getElementById(`${cell.id}_output`);
      if (outputDiv) {
        setElementInnerHtml(outputDiv, sanitizeHtml(''));
        updateOutputToggle(cell.id, false, false);
      }
    }
  });
  console.log('Kernel restarted.');
}

function closeAllDropdowns() {
  document.querySelectorAll('.menu-item').forEach((item) => {
    item.classList.remove('active');
  });
}

function getFocusedCell(): Cell | null {
  if (focusedCellId) {
    return cells.find((c) => c.id === focusedCellId) || null;
  }
  for (const cellId in monacoInstances) {
    if (Object.prototype.hasOwnProperty.call(monacoInstances, cellId)) {
      const editor = monacoInstances[cellId];
      if (editor && editor.hasTextFocus()) {
        focusedCellId = cellId;
        return cells.find((c) => c.id === cellId) || null;
      }
    }
  }
  if (cells.length > 0) {
    focusedCellId = cells[0].id;
    return cells[0];
  }
  return null;
}

function cutCell() {
  const cell = getFocusedCell();
  if (!cell) {
    alert('No cell selected to cut.');
    return;
  }
  const editor = monacoInstances[cell.id];
  const code = editor ? editor.getValue() : '';
  cellClipboard = {cellData: {...cell}, code};
  deleteCell(cell.id);
  console.log('Cell cut to clipboard.');
}

function copyCell() {
  const cell = getFocusedCell();
  if (!cell) {
    alert('No cell selected to copy.');
    return;
  }
  const editor = monacoInstances[cell.id];
  const code = editor ? editor.getValue() : '';
  cellClipboard = {cellData: {...cell}, code};
  console.log('Cell copied to clipboard.');
}

function pasteCell() {
  if (!cellClipboard) {
    alert('No cell in clipboard to paste.');
    return;
  }
  const focusedCell = getFocusedCell();
  let insertIndex = cells.length;
  if (focusedCell) {
    const focusedIndex = cells.findIndex((c) => c.id === focusedCell.id);
    insertIndex = focusedIndex + 1;
  }
  addCell(
    cellClipboard.code,
    cellClipboard.cellData.type,
    cellClipboard.cellData.type === 'md' &&
      cellClipboard.cellData.mode === 'render',
    cellClipboard.cellData.outputs || [],
    insertIndex,
  );
  console.log('Cell pasted from clipboard.');
}

function insertCellAbove(type: 'js' | 'md' = 'js') {
  const focusedCell = getFocusedCell();
  let insertIndex = 0;
  if (focusedCell) {
    const focusedIndex = cells.findIndex((c) => c.id === focusedCell.id);
    insertIndex = focusedIndex;
  }
  addCell('', type, false, [], insertIndex);
}

function insertCellBelow(type: 'js' | 'md' = 'js') {
  const focusedCell = getFocusedCell();
  let insertIndex = cells.length;
  if (focusedCell) {
    const focusedIndex = cells.findIndex((c) => c.id === focusedCell.id);
    insertIndex = focusedIndex + 1;
  }
  addCell('', type, false, [], insertIndex);
}

async function restartAndRunAll() {
  if (
    !confirm(
      'Are you sure you want to restart the kernel and run all cells? All variables will be lost.',
    )
  ) {
    return;
  }
  for (const key in persistentScope) {
    if (Object.prototype.hasOwnProperty.call(persistentScope, key)) {
      delete persistentScope[key];
    }
  }
  cells.forEach((cell) => {
    if (cell.type === 'js') {
      cell.outputs = [];
      const outputDiv = document.getElementById(`${cell.id}_output`);
      if (outputDiv) {
        setElementInnerHtml(outputDiv, sanitizeHtml(''));
        updateOutputToggle(cell.id, false, false);
      }
    }
  });
  console.log('Kernel restarted. Running all cells...');
  await runAllCells();
}

function markCellAsExecuted(cellId: string, content: string) {
  const cell = cells.find((c) => c.id === cellId);
  const cellElement = document.getElementById(`cell-container-${cellId}`);
  if (cell && cellElement) {
    cell.isExecuted = true;
    cell.lastExecutedContent = content;
    cellElement.classList.add('executed');
  }
}

function markCellAsUnexecuted(cellId: string) {
  const cell = cells.find((c) => c.id === cellId);
  const cellElement = document.getElementById(`cell-container-${cellId}`);
  if (cell && cellElement) {
    cell.isExecuted = false;
    cell.lastExecutedContent = undefined;
    cellElement.classList.remove('executed');
  }
}

function checkContentChanged(cellId: string, currentContent: string): boolean {
  const cell = cells.find((c) => c.id === cellId);
  return (
    !cell || !cell.isExecuted || cell.lastExecutedContent !== currentContent
  );
}

Object.assign(window, {
  addCell: async (code = '', type: 'js' | 'md' = 'js') => {
    try {
      await addCell(code, type);
    } catch (error) {
      console.error('Failed to add cell:', error);
      alert(
        `Error adding cell: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  deleteCell,
  runAllCells,
  runCell,
  moveCellUp: (cellId: string) => moveCell(cellId, 'up'),
  moveCellDown: (cellId: string) => moveCell(cellId, 'down'),
  restartKernel,
  cutCell,
  copyCell,
  pasteCell,
  insertCellAbove,
  insertCellBelow,
  restartAndRunAll,
  restoreVersion,
  deleteVersion,
  saveVersion,
});

(async () => {
  const metadataResponse = await fetch('metadata.json');
  appMetadata = (await metadataResponse.json()) as AppMetadata;

  const cookbookResponse = await fetch('cookbook.json');
  cookbookMetadata = (await cookbookResponse.json()) as CookbookData;

  rawLink = blobToRaw(cookbookMetadata.notebookCode);

  const notebookTitleElement = document.getElementById('notebook-title');
  if (notebookTitleElement) {
    // Sanitize metadata.name before setting as textContent to prevent any potential HTML content
    notebookTitleElement.textContent = String(appMetadata.name || '').replace(
      /<[^>]*>/g,
      '',
    );
  }
  // Sanitize metadata.title before setting as document title
  document.title = String(appMetadata.title || '').replace(/<[^>]*>/g, '');

  const NOTEBOOK_URL = rawLink;

  // Initialize Monaco Editor with proper CSS and workers
  loader.config({
    paths: {'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.54.0/min/vs'},
  });

  monaco = await loader.init();
  initThreeJS();
  loadVersions();

  monaco.editor.defineTheme('custom-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {'editor.background': '#252526'},
  });

  // Add collapsible copyright cell before loading notebook content
  const copyrightContent = `

Licensed under the Apache License, Version 2.0 (the "License");

You may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software 

distributed under the License is distributed on an "AS IS" BASIS,

WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

See the License for the specific language governing permissions and

limitations under the License.`;

  const copyrightCellDiv = document.createElement('div');
  copyrightCellDiv.className = 'cell copyright-cell rendered-md';
  copyrightCellDiv.id = 'copyright-cell';

  const collapseToggle = document.createElement('div');
  collapseToggle.className = 'collapse-toggle output-toggle output';
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-chevron-down';

  const span = document.createElement('span');
  span.style.fontWeight = 'bold';
  span.style.fontSize = '1.17em';

  const h2 = document.createElement('h5');
  h2.style.margin = '0 0.4em 0 0.4em';
  h2.textContent = `Copyright ${new Date().getFullYear()} Google LLC.`;

  span.appendChild(h2);
  collapseToggle.appendChild(icon);
  collapseToggle.appendChild(span);
  collapseToggle.addEventListener('click', () => {
    const content = document.getElementById('copyright-content');
    const icon = collapseToggle.querySelector('i');
    if (content && icon) {
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.className = 'fa-solid fa-chevron-up';
      } else {
        content.style.display = 'none';
        icon.className = 'fa-solid fa-chevron-down';
      }
    }
  });

  const copyrightContentDiv = document.createElement('div');
  copyrightContentDiv.id = 'copyright-content';
  copyrightContentDiv.className = 'output copyright-content';
  copyrightContentDiv.style.borderLeft = '3px solid #FFFFFF';
  copyrightContentDiv.style.paddingLeft = '1rem';
  copyrightContentDiv.style.marginLeft = '1.5rem';
  copyrightContentDiv.style.display = 'none';
  setElementInnerHtml(
    copyrightContentDiv,
    sanitizeHtml(md.render(copyrightContent)),
  );

  copyrightCellDiv.appendChild(collapseToggle);
  copyrightCellDiv.appendChild(copyrightContentDiv);
  notebook?.prepend(copyrightCellDiv);

  const inserter = document.createElement('div');
  inserter.id = 'cell-inserter';
  inserter.style.display = 'none';

  // Line 1
  const line1 = document.createElement('div');
  line1.className = 'inserter-line';

  // Buttons container
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'inserter-buttons';

  // Add Code Button
  const addCodeBtn = document.createElement('button');
  addCodeBtn.id = 'add-code-btn';
  addCodeBtn.title = 'Add Code Cell';
  const addCodeIcon = document.createElement('i');
  addCodeIcon.className = 'fa-solid fa-plus';
  addCodeBtn.appendChild(addCodeIcon);
  addCodeBtn.appendChild(document.createTextNode(' Code'));
  addCodeBtn.addEventListener('click', () => {
    const index = Number(inserter.dataset.index || '0');
    addCell('', 'js', false, [], index);
  });

  // Add Text Button
  const addTextBtn = document.createElement('button');
  addTextBtn.id = 'add-text-btn';
  addTextBtn.title = 'Add Markdown Cell';
  const addTextIcon = document.createElement('i');
  addTextIcon.className = 'fa-solid fa-plus';
  addTextBtn.appendChild(addTextIcon);
  addTextBtn.appendChild(document.createTextNode(' Text'));
  addTextBtn.addEventListener('click', () => {
    const index = Number(inserter.dataset.index || '0');
    addCell('', 'md', false, [], index);
  });

  buttonContainer.appendChild(addCodeBtn);
  buttonContainer.appendChild(addTextBtn);

  // Line 2
  const line2 = document.createElement('div');
  line2.className = 'inserter-line';

  // Assemble the complete inserter element
  inserter.appendChild(line1);
  inserter.appendChild(buttonContainer);
  inserter.appendChild(line2);

  // Add it to the notebook
  notebook?.appendChild(inserter);

  const menuEvents: Array<[string, () => void]> = [
    ['download-btn', downloadNotebook],
    ['github-btn', () => windowOpen(window, NOTEBOOK_URL, '_blank')],
    ['cut-cell-btn', cutCell],
    ['copy-cell-btn', copyCell],
    ['paste-cell-btn', pasteCell],
    ['insert-code-btn', () => insertCellBelow('js')],
    ['insert-md-btn', () => insertCellBelow('md')],
    ['insert-code-above-btn', () => insertCellAbove('js')],
    ['insert-md-above-btn', () => insertCellAbove('md')],
    ['run-all-btn', runAllCells],
    ['restart-kernel-btn', restartKernel],
    ['restart-run-all-btn', restartAndRunAll],
  ];

  menuEvents.forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        handler();
        closeAllDropdowns();
      });
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const isMenuButton = target.classList.contains('menu-button');
    document.querySelectorAll('.menu-item').forEach((item) => {
      if (!item.contains(target)) {
        item.classList.remove('active');
      }
    });
    if (isMenuButton) {
      const menuItem = target.closest('.menu-item');
      if (
        menuItem?.classList.contains('active') &&
        target === menuItem.querySelector('.menu-button')
      ) {
        menuItem.classList.remove('active');
      } else {
        menuItem?.classList.toggle('active');
      }
    }
  });

  try {
    const response = await fetch(NOTEBOOK_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch notebook: ${response.statusText}`);
    }
    const cellsData = parseNotebookFile(await response.text());
    if (!Array.isArray(cellsData) || cellsData.length === 0) {
      console.warn(
        'Notebook file is empty or contains no valid cells. Initializing with an empty code cell.',
      );
      await addCell('', 'js');
    } else {
      for (const cellData of cellsData) {
        await addCell(
          cellData.code,
          cellData.type,
          cellData.mode === 'render',
          cellData.outputs || [],
        );
      }
    }

    notebook.addEventListener('mousemove', (e) => {
      const cellElements = Array.from(notebook.getElementsByClassName('cell'));
      const y = e.clientY;
      let closestGapIndex = 0;
      let smallestDistance = Infinity;
      if (cellElements.length > 0) {
        const firstCellRect = (
          cellElements[0] as HTMLElement
        ).getBoundingClientRect();
        const distToFirst = Math.abs(y - firstCellRect.top);
        if (distToFirst < smallestDistance) {
          smallestDistance = distToFirst;
          closestGapIndex = 0;
        }
      } else {
        smallestDistance = 24;
        closestGapIndex = 0;
      }
      cellElements.forEach((cell, i) => {
        const rect = (cell as HTMLElement).getBoundingClientRect();
        const distance = Math.abs(y - rect.bottom);
        if (distance < smallestDistance) {
          smallestDistance = distance;
          closestGapIndex = i + 1;
        }
      });
      if (smallestDistance < 25) {
        let topPosition = 0;
        if (cellElements.length === 0) {
          topPosition =
            notebook.getBoundingClientRect().top +
            window.scrollY -
            inserter.offsetHeight / 2;
        } else if (closestGapIndex === 0) {
          topPosition =
            (cellElements[0] as HTMLElement).offsetTop -
            inserter.offsetHeight / 2;
        } else if (closestGapIndex > 0 && cellElements[closestGapIndex - 1]) {
          const targetCell = cellElements[closestGapIndex - 1] as HTMLElement;
          topPosition =
            targetCell.offsetTop +
            targetCell.offsetHeight -
            inserter.offsetHeight / 2;
        }
        inserter.style.top = `${Math.max(0, topPosition)}px`;
        inserter.dataset.index = `${closestGapIndex}`;
        inserter.style.display = 'flex';
      } else {
        inserter.style.display = 'none';
      }
    });
    notebook.addEventListener('mouseleave', (e) => {
      if (
        e.relatedTarget &&
        (e.relatedTarget as HTMLElement).closest &&
        (e.relatedTarget as HTMLElement).closest('#cell-inserter')
      ) {
        return;
      }
      inserter.style.display = 'none';
    });
    inserter.addEventListener('mouseleave', (e) => {
      if (
        e.relatedTarget === notebook ||
        (e.relatedTarget as HTMLElement).closest('.cell')
      ) {
        return;
      }
      inserter.style.display = 'none';
    });

    // this is used to drag and drop cells
    // tslint:disable-next-line:no-unused-expression
    new Sortable(notebook, {
      animation: 150,
      handle: '.drag-handle',
      onEnd: (evt: SortableEvent) => {
        if (
          evt.oldIndex !== undefined &&
          evt.newIndex !== undefined &&
          evt.oldIndex !== evt.newIndex
        ) {
          const [movedItem] = cells.splice(evt.oldIndex, 1);
          cells.splice(evt.newIndex, 0, movedItem);
        }
      },
    });
  } catch (error) {
    console.error('Failed to load notebook:', error);
    await addCell('', 'js');
  }
})();

export {};
