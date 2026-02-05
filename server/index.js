#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const ARTIFACTS = ["prd", "ux", "architecture", "epics_stories", "readiness"];
const ARTIFACT_GROUPS = {
  prd: ["ba", "design", "dev"],
  ux: ["ba", "design"],
  architecture: ["dev"],
  epics_stories: ["ba", "dev"],
  readiness: ["ba", "design", "dev"],
};

// Session state
let currentProject = null;
let projectsDir = join(homedir(), "signoff-projects");

const server = new Server(
  {
    name: "signoff-flow-mcp",
    version: "2.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ==================== Helper Functions ====================

function getOS() {
  const os = platform();
  if (os === "darwin") return "macos";
  if (os === "win32") return "windows";
  return "linux";
}

function commandExists(cmd) {
  try {
    const checkCmd = getOS() === "windows" ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isGhAuthenticated() {
  try {
    execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getGhUser() {
  try {
    const result = execSync("gh api user -q .login", { encoding: "utf-8", stdio: "pipe" });
    return result.trim();
  } catch {
    return null;
  }
}

async function installGhCli() {
  const os = getOS();
  
  try {
    if (os === "macos") {
      if (!commandExists("brew")) {
        const brewInstall = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
        await execAsync(brewInstall, { shell: "/bin/bash" });
      }
      await execAsync("brew install gh");
      return { success: true, message: "gh CLI installed successfully via Homebrew" };
    } 
    else if (os === "windows") {
      await execAsync("winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements");
      return { success: true, message: "gh CLI installed successfully via winget" };
    }
    else {
      return { 
        success: false, 
        message: "Unsupported operating system for automatic installation. Please install gh CLI manually: https://cli.github.com/" 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      message: `Error installing gh CLI: ${error.message}. Please install manually: https://cli.github.com/` 
    };
  }
}

function listGhOrgs() {
  try {
    const result = execSync("gh api user/orgs -q '.[].login'", { encoding: "utf-8", stdio: "pipe" });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function listOrgRepos(org, limit = 30) {
  try {
    const result = execSync(`gh repo list ${org} --limit ${limit} --json name,description,url`, { 
      encoding: "utf-8", 
      stdio: "pipe" 
    });
    return JSON.parse(result);
  } catch {
    return [];
  }
}

function listUserRepos(limit = 30) {
  try {
    const result = execSync(`gh repo list --limit ${limit} --json name,description,url,owner`, { 
      encoding: "utf-8", 
      stdio: "pipe" 
    });
    return JSON.parse(result);
  } catch {
    return [];
  }
}

function repoExistsOnGitHub(repoFullName) {
  try {
    execSync(`gh repo view ${repoFullName}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function cloneRepo(repoFullName, targetDir) {
  try {
    mkdirSync(targetDir, { recursive: true });
    execSync(`gh repo clone ${repoFullName} "${targetDir}"`, { encoding: "utf-8", stdio: "pipe" });
    return { success: true, path: targetDir };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getLocalProjects() {
  if (!existsSync(projectsDir)) {
    return [];
  }
  
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .filter(dirent => existsSync(join(projectsDir, dirent.name, ".git")))
    .map(dirent => {
      const projectPath = join(projectsDir, dirent.name);
      const hasGovernance = existsSync(join(projectPath, "_bmad-output", "governance", "governance.yaml"));
      
      let remoteUrl = null;
      try {
        remoteUrl = execSync("git remote get-url origin", { 
          cwd: projectPath, 
          encoding: "utf-8", 
          stdio: "pipe" 
        }).trim();
      } catch {}
      
      return {
        name: dirent.name,
        path: projectPath,
        hasGovernance,
        remoteUrl,
      };
    });
}

function getProjectRoot() {
  if (currentProject) {
    return currentProject;
  }
  if (process.env.PROJECT_ROOT) {
    return process.env.PROJECT_ROOT;
  }
  return null;
}

function getGovernancePath() {
  const root = getProjectRoot();
  if (!root) return null;
  return join(root, "_bmad-output", "governance", "governance.yaml");
}

function getInitiativePath(key) {
  return join(getProjectRoot(), "_bmad-output", "initiatives", key);
}

function governanceExists() {
  const path = getGovernancePath();
  return path && existsSync(path);
}

function loadGovernance() {
  if (!governanceExists()) return null;
  const content = readFileSync(getGovernancePath(), "utf-8");
  const lines = content.split("\n");
  const governance = { groups: {}, jira: {} };
  
  let currentGroup = null;
  
  for (const line of lines) {
    if (line.startsWith("  project_key:")) {
      governance.jira.project_key = line.split(":")[1].trim().replace(/"/g, "");
    }
    if (line.match(/^  (ba|design|dev):$/)) {
      currentGroup = line.trim().replace(":", "");
      governance.groups[currentGroup] = { leads: { github_users: [], jira_account_ids: [] } };
    }
    if (line.includes("github_users:") && currentGroup) {
      const match = line.match(/\[(.*)\]/);
      if (match) {
        governance.groups[currentGroup].leads.github_users = match[1]
          .split(",")
          .map(s => s.trim().replace(/"/g, ""));
      }
    }
    if (line.includes("jira_account_ids:") && currentGroup) {
      const match = line.match(/\[(.*)\]/);
      if (match) {
        governance.groups[currentGroup].leads.jira_account_ids = match[1]
          .split(",")
          .map(s => s.trim().replace(/"/g, ""));
      }
    }
  }
  
  return governance;
}

function initiativeExists(key) {
  return existsSync(join(getInitiativePath(key), "state.yaml"));
}

function loadInitiativeState(key) {
  const statePath = join(getInitiativePath(key), "state.yaml");
  if (!existsSync(statePath)) return null;
  const content = readFileSync(statePath, "utf-8");
  
  const stepMatch = content.match(/current_step:\s*(\w+)/);
  const currentStep = stepMatch ? stepMatch[1] : "prd";
  
  return { key, currentStep, raw: content };
}

function createInitiative(key, title) {
  const initPath = getInitiativePath(key);
  const artifactsPath = join(initPath, "artifacts");
  
  mkdirSync(artifactsPath, { recursive: true });
  
  const stateContent = `version: 1
key: "${key}"
title: "${title}"
external_ids:
  jira: ""

phase: planning
current_step: prd

governance_ref:
  path: _bmad-output/governance/governance.yaml

artifacts:
  prd:
    path: _bmad-output/initiatives/${key}/artifacts/PRD.md
    required_groups: [ba, design, dev]
    active:
      branch: "bmad/${key}/prd"
      pr_url: ""
      pr_number: null
      status: none

  ux:
    path: _bmad-output/initiatives/${key}/artifacts/UX.md
    required_groups: [ba, design]
    active:
      branch: "bmad/${key}/ux"
      pr_url: ""
      pr_number: null
      status: none

  architecture:
    path: _bmad-output/initiatives/${key}/artifacts/ARCHITECTURE.md
    required_groups: [dev]
    active:
      branch: "bmad/${key}/architecture"
      pr_url: ""
      pr_number: null
      status: none

  epics_stories:
    path: _bmad-output/initiatives/${key}/artifacts/EPICS_AND_STORIES.md
    required_groups: [ba, dev]
    active:
      branch: "bmad/${key}/epics-stories"
      pr_url: ""
      pr_number: null
      status: none

  readiness:
    path: _bmad-output/initiatives/${key}/artifacts/IMPLEMENTATION_READINESS.md
    required_groups: [ba, design, dev]
    active:
      branch: "bmad/${key}/readiness"
      pr_url: ""
      pr_number: null
      status: none

history: []
`;

  writeFileSync(join(initPath, "state.yaml"), stateContent);
  
  const timelineContent = `# Timeline: ${key}

## ${title}

---

### ${new Date().toISOString()} — Initiative Initialized

- **Phase:** planning
- **Step:** prd
- **Action:** Initiative created

---
`;
  writeFileSync(join(initPath, "timeline.md"), timelineContent);
  
  return { key, title, path: initPath };
}

function createArtifact(key, artifact) {
  const artifactPath = join(getInitiativePath(key), "artifacts", `${artifact.toUpperCase()}.md`);
  const content = `# ${artifact.toUpperCase()} (Mock)

**Initiative:** \`${key}\`  
**Current step:** \`${artifact}\`  
**Generated at:** \`${new Date().toISOString()}\`

---

This is a **stub artifact** for the signoff workflow.
Signoff happens via PR approval — repo/PR is source of truth.
`;
  
  mkdirSync(join(getInitiativePath(key), "artifacts"), { recursive: true });
  writeFileSync(artifactPath, content);
  return artifactPath;
}

function appendTimeline(key, entry) {
  const timelinePath = join(getInitiativePath(key), "timeline.md");
  appendFileSync(timelinePath, `\n### ${new Date().toISOString()} — ${entry.title}\n\n${entry.content}\n\n---\n`);
}

// ==================== Tool Definitions ====================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ===== SETUP TOOLS =====
      {
        name: "signoff_check_setup",
        description: "Check if the environment is ready to use signoff tools. Verifies gh CLI installation and authentication. ALWAYS call this first before any other tool.",
        inputSchema: {
          type: "object",
          properties: {
            auto_install: {
              type: "boolean",
              description: "If true, automatically install gh CLI if not present (default: true)",
              default: true,
            },
          },
        },
      },
      {
        name: "signoff_authenticate",
        description: "Start the GitHub authentication process. Opens a browser for the user to log in.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      
      // ===== PROJECT MANAGEMENT TOOLS =====
      {
        name: "signoff_list_projects",
        description: "List available projects. Shows local cloned projects and optionally fetches from GitHub organizations.",
        inputSchema: {
          type: "object",
          properties: {
            include_remote: {
              type: "boolean",
              description: "If true, also list projects from GitHub orgs (requires gh authentication)",
              default: true,
            },
            org: {
              type: "string",
              description: "Optional: specific GitHub org to list repos from",
            },
          },
        },
      },
      {
        name: "signoff_select_project",
        description: "Select a project to work with. Can be a local path or a GitHub repo (org/repo format).",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Project identifier: local folder name, absolute path, or GitHub repo (e.g., 'my-project', '/path/to/project', or 'org/repo')",
            },
          },
          required: ["project"],
        },
      },
      {
        name: "signoff_clone_project",
        description: "Clone a GitHub repository to work with locally.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "GitHub repo in 'owner/repo' format (e.g., 'HALO/my-project')",
            },
            folder_name: {
              type: "string",
              description: "Optional: custom folder name for the cloned repo",
            },
          },
          required: ["repo"],
        },
      },
      
      // ===== WORKFLOW TOOLS =====
      {
        name: "signoff_status",
        description: "Check the status of governance and initiatives for the current project.",
        inputSchema: {
          type: "object",
          properties: {
            initiative_key: {
              type: "string",
              description: "Optional: specific initiative key to check status for",
            },
          },
        },
      },
      {
        name: "signoff_setup_governance",
        description: "Set up governance with leads for BA, Design, and Dev groups. Required before creating initiatives.",
        inputSchema: {
          type: "object",
          properties: {
            ba_leads: {
              type: "array",
              items: { type: "string" },
              description: "GitHub usernames of BA leads",
            },
            design_leads: {
              type: "array",
              items: { type: "string" },
              description: "GitHub usernames of Design leads",
            },
            dev_leads: {
              type: "array",
              items: { type: "string" },
              description: "GitHub usernames of Dev leads",
            },
            jira_project_key: {
              type: "string",
              description: "Jira project key (e.g., 'PROJ')",
            },
          },
          required: ["ba_leads", "design_leads", "dev_leads", "jira_project_key"],
        },
      },
      {
        name: "signoff_new_initiative",
        description: "Create a new initiative. Governance must be set up first.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Initiative key (e.g., 'FEAT-123' or 'INIT-001')",
            },
            title: {
              type: "string",
              description: "Initiative title",
            },
          },
          required: ["key", "title"],
        },
      },
      {
        name: "signoff_advance",
        description: "Advance an initiative to create the next artifact, PR, and Jira tickets.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Initiative key",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "signoff_create_jira_tickets",
        description: "Create Jira signoff tickets for the current artifact step.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Initiative key",
            },
            artifact: {
              type: "string",
              description: "Artifact name (prd, ux, architecture, epics_stories, readiness)",
            },
            pr_url: {
              type: "string",
              description: "GitHub PR URL to include in tickets",
            },
          },
          required: ["key", "artifact"],
        },
      },
    ],
  };
});

// ==================== Tool Handlers ====================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ===== SETUP TOOLS =====
      case "signoff_check_setup": {
        const autoInstall = args?.auto_install !== false;
        let result = `## 🔧 Environment Check\n\n`;
        
        // Check OS
        const os = getOS();
        result += `**Operating System:** ${os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux"}\n`;
        result += `**Projects Directory:** ${projectsDir}\n\n`;
        
        // Check gh CLI
        const ghInstalled = commandExists("gh");
        
        if (!ghInstalled) {
          result += `### ❌ gh CLI not installed\n\n`;
          
          if (autoInstall) {
            result += `Installing gh CLI automatically...\n\n`;
            const installResult = await installGhCli();
            
            if (installResult.success) {
              result += `✅ ${installResult.message}\n\n`;
            } else {
              result += `⚠️ ${installResult.message}\n\n`;
              return { content: [{ type: "text", text: result }] };
            }
          } else {
            result += `To install manually:\n`;
            if (os === "macos") {
              result += `\`\`\`bash\nbrew install gh\n\`\`\`\n`;
            } else if (os === "windows") {
              result += `\`\`\`powershell\nwinget install --id GitHub.cli\n\`\`\`\n`;
            }
            return { content: [{ type: "text", text: result }] };
          }
        } else {
          result += `### ✅ gh CLI installed\n\n`;
        }
        
        // Check authentication
        const isAuth = isGhAuthenticated();
        
        if (!isAuth) {
          result += `### ❌ Not authenticated to GitHub\n\n`;
          result += `You need to authenticate to access your repositories.\n\n`;
          result += `**Next step:** Use the \`signoff_authenticate\` tool to start the login process.\n`;
          
          return { 
            content: [{ type: "text", text: result }],
            isError: false,
          };
        }
        
        const user = getGhUser();
        result += `### ✅ Authenticated as: ${user}\n\n`;
        
        // Check if project is selected
        if (currentProject) {
          result += `### ✅ Active project: ${currentProject}\n\n`;
        } else {
          result += `### ⚠️ No project selected\n\n`;
          result += `**Next step:** Use \`signoff_list_projects\` to see available projects.\n`;
        }
        
        result += `\n---\n\n**Status:** ✅ Ready to use\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_authenticate": {
        let result = `## 🔐 GitHub Authentication\n\n`;
        
        if (isGhAuthenticated()) {
          const user = getGhUser();
          result += `✅ You are already authenticated as **${user}**\n\n`;
          result += `If you want to switch accounts, run in terminal:\n\`\`\`bash\ngh auth logout\ngh auth login\n\`\`\`\n`;
          return { content: [{ type: "text", text: result }] };
        }
        
        result += `To authenticate, please follow these steps:\n\n`;
        result += `1. **Open a terminal** on your computer\n`;
        result += `2. **Run this command:**\n`;
        result += `\`\`\`bash\ngh auth login\n\`\`\`\n`;
        result += `3. **Follow the prompts:**\n`;
        result += `   - Select "GitHub.com"\n`;
        result += `   - Select "HTTPS"\n`;
        result += `   - Select "Login with a web browser"\n`;
        result += `   - Copy the code that appears\n`;
        result += `   - Your browser will open, paste the code\n`;
        result += `   - Authorize the application\n\n`;
        result += `4. **When done**, come back here and use \`signoff_check_setup\` to verify.\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      // ===== PROJECT MANAGEMENT TOOLS =====
      case "signoff_list_projects": {
        if (!commandExists("gh")) {
          return {
            content: [{
              type: "text",
              text: "❌ gh CLI is not installed. Use `signoff_check_setup` first.",
            }],
            isError: true,
          };
        }
        
        let result = `## 📁 Available Projects\n\n`;
        
        // Local projects
        const localProjects = getLocalProjects();
        
        result += `### Local Projects (${projectsDir})\n\n`;
        
        if (localProjects.length === 0) {
          result += `*No projects cloned yet.*\n\n`;
        } else {
          for (const proj of localProjects) {
            const govIcon = proj.hasGovernance ? "✅" : "⚪";
            const activeIcon = currentProject === proj.path ? "👉 " : "";
            result += `${activeIcon}- **${proj.name}** ${govIcon}\n`;
            result += `  Path: \`${proj.path}\`\n`;
            if (proj.remoteUrl) {
              result += `  Remote: ${proj.remoteUrl}\n`;
            }
            result += `\n`;
          }
        }
        
        // Remote projects (if authenticated and requested)
        if (args?.include_remote !== false && isGhAuthenticated()) {
          result += `### GitHub Projects\n\n`;
          
          if (args?.org) {
            const repos = listOrgRepos(args.org);
            result += `**Organization: ${args.org}**\n\n`;
            
            if (repos.length === 0) {
              result += `*No repositories found.*\n\n`;
            } else {
              for (const repo of repos.slice(0, 15)) {
                const isCloned = localProjects.some(p => p.remoteUrl?.includes(repo.url));
                const clonedIcon = isCloned ? "✅ (cloned)" : "○";
                result += `- **${args.org}/${repo.name}** ${clonedIcon}\n`;
                if (repo.description) {
                  result += `  ${repo.description}\n`;
                }
              }
              if (repos.length > 15) {
                result += `\n*...and ${repos.length - 15} more*\n`;
              }
            }
          } else {
            const orgs = listGhOrgs();
            const user = getGhUser();
            
            result += `**Your repositories (@${user}):**\n\n`;
            const userRepos = listUserRepos(10);
            for (const repo of userRepos.slice(0, 5)) {
              const fullName = `${repo.owner.login}/${repo.name}`;
              const isCloned = localProjects.some(p => p.remoteUrl?.includes(fullName));
              const clonedIcon = isCloned ? "✅" : "○";
              result += `- ${fullName} ${clonedIcon}\n`;
            }
            
            if (orgs.length > 0) {
              result += `\n**Organizations:**\n`;
              for (const org of orgs.slice(0, 5)) {
                result += `- ${org} (use \`signoff_list_projects\` with \`org: "${org}"\` to see repos)\n`;
              }
            }
          }
        }
        
        result += `\n---\n\n`;
        result += `**To select a project:** \`signoff_select_project\` with the name or "org/repo"\n`;
        result += `**To clone a new project:** \`signoff_clone_project\` with "org/repo"\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_select_project": {
        const project = args.project;
        let result = `## Project Selection\n\n`;
        
        // Case 1: Absolute path
        if (project.startsWith("/") || project.startsWith("C:") || project.startsWith("~")) {
          const resolvedPath = project.startsWith("~") ? project.replace("~", homedir()) : project;
          
          if (!existsSync(resolvedPath)) {
            return {
              content: [{
                type: "text",
                text: `❌ Directory does not exist: ${resolvedPath}\n\nUse \`signoff_clone_project\` to clone a repository.`,
              }],
              isError: true,
            };
          }
          
          currentProject = resolvedPath;
          result += `✅ Project selected: ${resolvedPath}\n`;
        }
        // Case 2: GitHub repo (contains /)
        else if (project.includes("/")) {
          const repoName = project.split("/")[1];
          const localPath = join(projectsDir, repoName);
          
          if (existsSync(localPath)) {
            currentProject = localPath;
            result += `✅ Project found locally: ${localPath}\n`;
          } else {
            if (!commandExists("gh") || !isGhAuthenticated()) {
              return {
                content: [{
                  type: "text",
                  text: `❌ Project ${project} is not cloned and cannot verify on GitHub.\n\nUse \`signoff_check_setup\` to configure gh CLI.`,
                }],
                isError: true,
              };
            }
            
            if (repoExistsOnGitHub(project)) {
              result += `⚠️ Project ${project} exists on GitHub but is not cloned.\n\n`;
              result += `Would you like to clone it? Use:\n`;
              result += `\`signoff_clone_project\` with \`repo: "${project}"\`\n`;
              return { content: [{ type: "text", text: result }] };
            } else {
              return {
                content: [{
                  type: "text",
                  text: `❌ Repository not found: ${project}\n\nVerify the name is correct (format: owner/repo).`,
                }],
                isError: true,
              };
            }
          }
        }
        // Case 3: Local folder name
        else {
          const localPath = join(projectsDir, project);
          
          if (existsSync(localPath)) {
            currentProject = localPath;
            result += `✅ Project selected: ${localPath}\n`;
          } else {
            return {
              content: [{
                type: "text",
                text: `❌ Project not found: ${project}\n\nLocal projects are in: ${projectsDir}\n\nUse \`signoff_list_projects\` to see available projects.`,
              }],
              isError: true,
            };
          }
        }
        
        const hasGovernance = governanceExists();
        result += `**Governance:** ${hasGovernance ? "✅ Configured" : "⚠️ Not configured"}\n`;
        
        if (!hasGovernance) {
          result += `\n**Next step:** Use \`signoff_setup_governance\` to configure leads.\n`;
        } else {
          result += `\n**Next step:** Use \`signoff_status\` to see project status.\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_clone_project": {
        if (!commandExists("gh")) {
          return {
            content: [{
              type: "text",
              text: "❌ gh CLI is not installed. Use `signoff_check_setup` first.",
            }],
            isError: true,
          };
        }
        
        if (!isGhAuthenticated()) {
          return {
            content: [{
              type: "text",
              text: "❌ Not authenticated to GitHub. Use `signoff_authenticate` first.",
            }],
            isError: true,
          };
        }
        
        const repo = args.repo;
        const folderName = args.folder_name || repo.split("/")[1];
        const targetDir = join(projectsDir, folderName);
        
        if (existsSync(targetDir)) {
          return {
            content: [{
              type: "text",
              text: `⚠️ Directory already exists: ${targetDir}\n\nUse \`signoff_select_project\` with \`project: "${folderName}"\` to select it.`,
            }],
          };
        }
        
        if (!repoExistsOnGitHub(repo)) {
          return {
            content: [{
              type: "text",
              text: `❌ Repository not found: ${repo}\n\nVerify the name is correct and that you have access.`,
            }],
            isError: true,
          };
        }
        
        let result = `## Cloning ${repo}\n\n`;
        result += `Destination: ${targetDir}\n\n`;
        
        const cloneResult = cloneRepo(repo, targetDir);
        
        if (cloneResult.success) {
          currentProject = targetDir;
          result += `✅ Successfully cloned!\n\n`;
          result += `**Active project:** ${targetDir}\n`;
          
          const hasGovernance = governanceExists();
          result += `**Governance:** ${hasGovernance ? "✅ Configured" : "⚠️ Not configured"}\n`;
          
          if (!hasGovernance) {
            result += `\n**Next step:** Use \`signoff_setup_governance\` to configure leads.\n`;
          }
        } else {
          result += `❌ Clone failed: ${cloneResult.error}\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }
      
      // ===== WORKFLOW TOOLS =====
      case "signoff_status": {
        const projectRoot = getProjectRoot();
        let result = `## Signoff Flow Status\n\n`;
        
        if (!projectRoot) {
          result += `❌ No project selected.\n\n`;
          result += `Use \`signoff_select_project\` to select a project.\n`;
          return { content: [{ type: "text", text: result }] };
        }
        
        result += `**Project:** ${projectRoot}\n\n`;
        
        const hasGovernance = governanceExists();
        result += `**Governance:** ${hasGovernance ? "✅ Configured" : "❌ Not configured"}\n\n`;
        
        if (hasGovernance) {
          const governance = loadGovernance();
          result += `**Jira Project:** ${governance?.jira?.project_key || "Unknown"}\n`;
          result += `**BA Leads:** ${governance?.groups?.ba?.leads?.github_users?.join(", ") || "None"}\n`;
          result += `**Design Leads:** ${governance?.groups?.design?.leads?.github_users?.join(", ") || "None"}\n`;
          result += `**Dev Leads:** ${governance?.groups?.dev?.leads?.github_users?.join(", ") || "None"}\n\n`;
        }
        
        if (args?.initiative_key) {
          const state = loadInitiativeState(args.initiative_key);
          if (state) {
            result += `### Initiative: ${args.initiative_key}\n`;
            result += `**Current Step:** ${state.currentStep}\n`;
            const stepIndex = ARTIFACTS.indexOf(state.currentStep);
            result += `**Progress:** ${stepIndex + 1}/${ARTIFACTS.length} (${ARTIFACTS.join(" → ")})\n`;
          } else {
            result += `\n❌ Initiative ${args.initiative_key} not found.\n`;
          }
        }
        
        return { content: [{ type: "text", text: result }] };
      }

      case "signoff_setup_governance": {
        const projectRoot = getProjectRoot();
        if (!projectRoot) {
          return {
            content: [{
              type: "text",
              text: "❌ No project selected. Use `signoff_select_project` first.",
            }],
            isError: true,
          };
        }
        
        const govPath = getGovernancePath();
        mkdirSync(join(projectRoot, "_bmad-output", "governance"), { recursive: true });
        
        const content = `version: 1

groups:
  ba:
    leads:
      github_users: [${args.ba_leads.map(l => `"${l}"`).join(", ")}]
      jira_account_ids: []
    github:
      team_slug: ""

  design:
    leads:
      github_users: [${args.design_leads.map(l => `"${l}"`).join(", ")}]
      jira_account_ids: []
    github:
      team_slug: ""

  dev:
    leads:
      github_users: [${args.dev_leads.map(l => `"${l}"`).join(", ")}]
      jira_account_ids: []
    github:
      team_slug: ""

jira:
  project_key: "${args.jira_project_key}"
  issue_types:
    signoff_request: "Task"

signoff_rules:
  prd:
    required_groups: [ba, design, dev]
  ux:
    required_groups: [ba, design]
  architecture:
    required_groups: [dev]
  epics_stories:
    required_groups: [ba, dev]
  readiness:
    required_groups: [ba, design, dev]
`;
        
        writeFileSync(govPath, content);
        
        return {
          content: [{
            type: "text",
            text: `✅ Governance configured!\n\n**Path:** ${govPath}\n**Jira Project:** ${args.jira_project_key}\n**BA Leads:** ${args.ba_leads.join(", ")}\n**Design Leads:** ${args.design_leads.join(", ")}\n**Dev Leads:** ${args.dev_leads.join(", ")}\n\nYou can now create initiatives with \`signoff_new_initiative\`.`,
          }],
        };
      }

      case "signoff_new_initiative": {
        if (!getProjectRoot()) {
          return {
            content: [{
              type: "text",
              text: "❌ No project selected. Use `signoff_select_project` first.",
            }],
            isError: true,
          };
        }
        
        if (!governanceExists()) {
          return {
            content: [{
              type: "text",
              text: "❌ Governance not configured. Use `signoff_setup_governance` first.",
            }],
          };
        }
        
        if (initiativeExists(args.key)) {
          return {
            content: [{
              type: "text",
              text: `❌ Initiative ${args.key} already exists. Use \`signoff_advance\` to continue.`,
            }],
          };
        }
        
        const result = createInitiative(args.key, args.title);
        
        return {
          content: [{
            type: "text",
            text: `✅ Initiative created!\n\n**Key:** ${result.key}\n**Title:** ${result.title}\n**Path:** ${result.path}\n**Current Step:** prd\n\nNext: Use \`signoff_advance\` to create the PRD artifact and PR.`,
          }],
        };
      }

      case "signoff_advance": {
        if (!initiativeExists(args.key)) {
          return {
            content: [{
              type: "text",
              text: `❌ Initiative ${args.key} not found. Create it with \`signoff_new_initiative\`.`,
            }],
          };
        }
        
        const state = loadInitiativeState(args.key);
        const currentStep = state.currentStep;
        const stepIndex = ARTIFACTS.indexOf(currentStep);
        
        if (stepIndex === -1) {
          return {
            content: [{
              type: "text",
              text: `❌ Unknown step: ${currentStep}`,
            }],
          };
        }
        
        if (stepIndex >= ARTIFACTS.length - 1 && currentStep === "readiness") {
          return {
            content: [{
              type: "text",
              text: `✅ Initiative ${args.key} is complete! All artifacts have been signed off.`,
            }],
          };
        }
        
        const artifactPath = createArtifact(args.key, currentStep);
        const groups = ARTIFACT_GROUPS[currentStep];
        
        appendTimeline(args.key, {
          title: `${currentStep.toUpperCase()} Step Started`,
          content: `- **Phase:** planning\n- **Step:** ${currentStep}\n- **Action:** Created artifact stub\n- **Required groups:** ${groups.join(", ")}`,
        });
        
        return {
          content: [{
            type: "text",
            text: `✅ Artifact created!\n\n**Initiative:** ${args.key}\n**Step:** ${currentStep.toUpperCase()}\n**Artifact:** ${artifactPath}\n**Required signoffs:** ${groups.join(", ")}\n\n**Next steps:**\n1. Create a GitHub PR for branch \`bmad/${args.key}/${currentStep}\`\n2. Create Jira tickets with \`signoff_create_jira_tickets\`\n3. Request reviews from leads\n4. When PR is merged, run \`signoff_advance\` again`,
          }],
        };
      }

      case "signoff_create_jira_tickets": {
        const groups = ARTIFACT_GROUPS[args.artifact];
        if (!groups) {
          return {
            content: [{
              type: "text",
              text: `❌ Unknown artifact: ${args.artifact}. Valid options: ${ARTIFACTS.join(", ")}`,
            }],
          };
        }
        
        const governance = loadGovernance();
        const jiraProject = governance?.jira?.project_key || "UNKNOWN";
        
        let result = `## Jira Tickets to Create\n\n`;
        result += `Use the Atlassian MCP to create these tickets:\n\n`;
        
        for (const group of groups) {
          result += `### ${group.toUpperCase()} Signoff\n`;
          result += `- **Summary:** \`[BMAD][${args.key}][${args.artifact}] Signoff required — ${group.toUpperCase()}\`\n`;
          result += `- **Project:** ${jiraProject}\n`;
          result += `- **Type:** Task\n`;
          result += `- **Labels:** bmad, initiative-${args.key}, artifact-${args.artifact}, group-${group}\n`;
          result += `- **Description:**\n\`\`\`\nBMAD signoff requested (lead-only).\n\nInitiative: ${args.key}\nArtifact: ${args.artifact.toUpperCase()}\nGroup: ${group.toUpperCase()}\n\nPR: ${args.pr_url || "(pending)"}\n\nAction: Approve the PR to sign off.\n\`\`\`\n\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }

      default:
        return {
          content: [{
            type: "text",
            text: `Unknown tool: ${name}`,
          }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`,
      }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
