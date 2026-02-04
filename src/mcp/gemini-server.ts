/**
 * Gemini MCP Server - In-process MCP server for Google Gemini CLI integration
 *
 * Exposes `ask_gemini` tool via the Claude Agent SDK's createSdkMcpServer helper.
 * Tools will be available as mcp__g__ask_gemini
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { detectGeminiCli } from './cli-detection.js';
import { resolveSystemPrompt, buildPromptWithSystemContext } from './prompt-injection.js';

// Default model can be overridden via environment variable
const GEMINI_DEFAULT_MODEL = process.env.OMC_GEMINI_DEFAULT_MODEL || 'gemini-3-pro';
const GEMINI_TIMEOUT = parseInt(process.env.OMC_GEMINI_TIMEOUT || '120000', 10);

/**
 * Execute Gemini CLI command and return the response
 */
function executeGemini(prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--yolo'];
    if (model) {
      args.push('--model', model);
    }
    const child = spawn('gemini', args, {
      timeout: GEMINI_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Gemini exited with code ${code}: ${stderr || 'No output'}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
    });

    // Pipe prompt via stdin to avoid OS argument length limits
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Define the ask_gemini tool using the SDK tool() helper
const askGeminiTool = tool(
  "ask_gemini",
  "Send a prompt to Google Gemini CLI for large-context analysis, second-opinion review, or alternative perspective. Gemini excels at analyzing large files with its 1M token context window. Requires Gemini CLI to be installed (npm install -g @google/gemini-cli).",
  {
    prompt: { type: "string", description: "The prompt to send to Gemini" },
    model: { type: "string", description: `Gemini model to use (default: ${GEMINI_DEFAULT_MODEL}). Set OMC_GEMINI_DEFAULT_MODEL env var to change default. Options include: gemini-2.5-pro, gemini-2.5-flash` },
    files: { type: "array", items: { type: "string" }, description: "File paths for Gemini to analyze (leverages 1M token context window)" },
    system_prompt: { type: "string", description: "System prompt to inject - sets the personality/guidelines for Gemini. Takes precedence over agent_role." },
    agent_role: { type: "string", description: "Agent role shortcut (e.g. 'designer', 'architect', 'critic'). Loads the agent's system prompt automatically. Ignored if system_prompt is provided." },
  } as any,
  async (args: any) => {
    const { prompt, model = GEMINI_DEFAULT_MODEL, files, system_prompt, agent_role } = args as {
      prompt: string;
      model?: string;
      files?: string[];
      system_prompt?: string;
      agent_role?: string;
    };

    // Check CLI availability
    const detection = detectGeminiCli();
    if (!detection.available) {
      return {
        content: [{
          type: 'text' as const,
          text: `Gemini CLI is not available: ${detection.error}\n\n${detection.installHint}`
        }]
      };
    }

    // Resolve system prompt from explicit param or agent role
    const resolvedSystemPrompt = resolveSystemPrompt(system_prompt, agent_role);

    // Build file context
    let fileContext: string | undefined;
    if (files && files.length > 0) {
      fileContext = files.map(f => {
        try {
          return `--- File: ${f} ---\n${readFileSync(f, 'utf-8')}`;
        } catch (err) {
          return `--- File: ${f} --- (Error reading: ${(err as Error).message})`;
        }
      }).join('\n\n');
    }

    // Combine: system prompt > file context > user prompt
    const fullPrompt = buildPromptWithSystemContext(prompt, fileContext, resolvedSystemPrompt);

    try {
      const response = await executeGemini(fullPrompt, model);
      return {
        content: [{
          type: 'text' as const,
          text: response
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Gemini CLI error: ${(err as Error).message}`
        }]
      };
    }
  }
);

/**
 * In-process MCP server exposing Gemini CLI integration
 *
 * Tools will be available as mcp__g__ask_gemini
 */
export const geminiMcpServer = createSdkMcpServer({
  name: "g",
  version: "1.0.0",
  tools: [askGeminiTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const geminiToolNames = ['ask_gemini'];
