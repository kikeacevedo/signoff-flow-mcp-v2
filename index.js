#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, execSync, spawn } from "child_process";
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
    version: "2.0.0",
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
    const result = execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
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
      // Check if Homebrew exists
      if (!commandExists("brew")) {
        // Install Homebrew first
        const brewInstall = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
        await execAsync(brewInstall, { shell: "/bin/bash" });
      }
      // Install gh
      await execAsync("brew install gh");
      return { success: true, message: "gh CLI instalado correctamente via Homebrew" };
    } 
    else if (os === "windows") {
      // Use winget (comes with Windows 11, available on Windows 10)
      await execAsync("winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements");
      return { success: true, message: "gh CLI instalado correctamente via winget" };
    }
    else {
      return { 
        success: false, 
        message: "Sistema operativo no soportado para instalación automática. Por favor instala gh CLI manualmente: https://cli.github.com/" 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      message: `Error instalando gh CLI: ${error.message}. Por favor instala manualmente: https://cli.github.com/` 
    };
  }
}

async function authenticateGh() {
  try {
    // Start web-based authentication
    const result = await execAsync("gh auth login --web --git-protocol https", { timeout: 120000 });
    return { success: true, message: "Autenticación completada" };
  } catch (error) {
    return { 
      success: false, 
      message: `Para autenticarte, abre una terminal y ejecuta: gh auth login\n\nSigue las instrucciones para completar la autenticación via navegador.`
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
      
      // Try to get remote URL
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
        let result = `## 🔧 Verificación del Entorno\n\n`;
        
        // Check OS
        const os = getOS();
        result += `**Sistema Operativo:** ${os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux"}\n`;
        result += `**Directorio de proyectos:** ${projectsDir}\n\n`;
        
        // Check gh CLI
        const ghInstalled = commandExists("gh");
        
        if (!ghInstalled) {
          result += `### ❌ gh CLI no instalado\n\n`;
          
          if (autoInstall) {
            result += `Instalando gh CLI automáticamente...\n\n`;
            const installResult = await installGhCli();
            
            if (installResult.success) {
              result += `✅ ${installResult.message}\n\n`;
            } else {
              result += `⚠️ ${installResult.message}\n\n`;
              return { content: [{ type: "text", text: result }] };
            }
          } else {
            result += `Para instalar manualmente:\n`;
            if (os === "macos") {
              result += `\`\`\`bash\nbrew install gh\n\`\`\`\n`;
            } else if (os === "windows") {
              result += `\`\`\`powershell\nwinget install --id GitHub.cli\n\`\`\`\n`;
            }
            return { content: [{ type: "text", text: result }] };
          }
        } else {
          result += `### ✅ gh CLI instalado\n\n`;
        }
        
        // Check authentication
        const isAuth = isGhAuthenticated();
        
        if (!isAuth) {
          result += `### ❌ No autenticado en GitHub\n\n`;
          result += `Necesitas autenticarte para acceder a tus repositorios.\n\n`;
          result += `**Siguiente paso:** Usa la herramienta \`signoff_authenticate\` para iniciar el proceso de login.\n`;
          
          return { 
            content: [{ type: "text", text: result }],
            isError: false,
          };
        }
        
        const user = getGhUser();
        result += `### ✅ Autenticado como: ${user}\n\n`;
        
        // Check if project is selected
        if (currentProject) {
          result += `### ✅ Proyecto activo: ${currentProject}\n\n`;
        } else {
          result += `### ⚠️ Ningún proyecto seleccionado\n\n`;
          result += `**Siguiente paso:** Usa \`signoff_list_projects\` para ver proyectos disponibles.\n`;
        }
        
        result += `\n---\n\n**Estado:** ✅ Listo para usar\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_authenticate": {
        let result = `## 🔐 Autenticación de GitHub\n\n`;
        
        if (isGhAuthenticated()) {
          const user = getGhUser();
          result += `✅ Ya estás autenticado como **${user}**\n\n`;
          result += `Si quieres cambiar de cuenta, ejecuta en terminal:\n\`\`\`bash\ngh auth logout\ngh auth login\n\`\`\`\n`;
          return { content: [{ type: "text", text: result }] };
        }
        
        result += `Para autenticarte, necesito que hagas lo siguiente:\n\n`;
        result += `1. **Abre una terminal** en tu computadora\n`;
        result += `2. **Ejecuta este comando:**\n`;
        result += `\`\`\`bash\ngh auth login\n\`\`\`\n`;
        result += `3. **Sigue las instrucciones:**\n`;
        result += `   - Selecciona "GitHub.com"\n`;
        result += `   - Selecciona "HTTPS"\n`;
        result += `   - Selecciona "Login with a web browser"\n`;
        result += `   - Copia el código que aparece\n`;
        result += `   - Se abrirá tu navegador, pega el código\n`;
        result += `   - Autoriza la aplicación\n\n`;
        result += `4. **Cuando termines**, vuelve aquí y usa \`signoff_check_setup\` para verificar.\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      // ===== PROJECT MANAGEMENT TOOLS =====
      case "signoff_list_projects": {
        if (!commandExists("gh")) {
          return {
            content: [{
              type: "text",
              text: "❌ gh CLI no está instalado. Usa `signoff_check_setup` primero.",
            }],
            isError: true,
          };
        }
        
        let result = `## 📁 Proyectos Disponibles\n\n`;
        
        // Local projects
        const localProjects = getLocalProjects();
        
        result += `### Proyectos Locales (${projectsDir})\n\n`;
        
        if (localProjects.length === 0) {
          result += `*No hay proyectos clonados todavía.*\n\n`;
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
          result += `### Proyectos en GitHub\n\n`;
          
          if (args?.org) {
            // Specific org
            const repos = listOrgRepos(args.org);
            result += `**Organización: ${args.org}**\n\n`;
            
            if (repos.length === 0) {
              result += `*No se encontraron repositorios.*\n\n`;
            } else {
              for (const repo of repos.slice(0, 15)) {
                const isCloned = localProjects.some(p => p.remoteUrl?.includes(repo.url));
                const clonedIcon = isCloned ? "✅ (clonado)" : "○";
                result += `- **${args.org}/${repo.name}** ${clonedIcon}\n`;
                if (repo.description) {
                  result += `  ${repo.description}\n`;
                }
              }
              if (repos.length > 15) {
                result += `\n*...y ${repos.length - 15} más*\n`;
              }
            }
          } else {
            // User's orgs
            const orgs = listGhOrgs();
            const user = getGhUser();
            
            // User's own repos
            result += `**Tus repositorios (@${user}):**\n\n`;
            const userRepos = listUserRepos(10);
            for (const repo of userRepos.slice(0, 5)) {
              const fullName = `${repo.owner.login}/${repo.name}`;
              const isCloned = localProjects.some(p => p.remoteUrl?.includes(fullName));
              const clonedIcon = isCloned ? "✅" : "○";
              result += `- ${fullName} ${clonedIcon}\n`;
            }
            
            // Org repos
            if (orgs.length > 0) {
              result += `\n**Organizaciones:**\n`;
              for (const org of orgs.slice(0, 5)) {
                result += `- ${org} (usa \`signoff_list_projects\` con \`org: "${org}"\` para ver repos)\n`;
              }
            }
          }
        }
        
        result += `\n---\n\n`;
        result += `**Para seleccionar un proyecto:** \`signoff_select_project\` con el nombre o "org/repo"\n`;
        result += `**Para clonar un nuevo proyecto:** \`signoff_clone_project\` con "org/repo"\n`;
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_select_project": {
        const project = args.project;
        let result = `## Selección de Proyecto\n\n`;
        
        // Case 1: Absolute path
        if (project.startsWith("/") || project.startsWith("C:") || project.startsWith("~")) {
          const resolvedPath = project.startsWith("~") ? project.replace("~", homedir()) : project;
          
          if (!existsSync(resolvedPath)) {
            return {
              content: [{
                type: "text",
                text: `❌ El directorio no existe: ${resolvedPath}\n\nUsa \`signoff_clone_project\` para clonar un repositorio.`,
              }],
              isError: true,
            };
          }
          
          currentProject = resolvedPath;
          result += `✅ Proyecto seleccionado: ${resolvedPath}\n`;
        }
        // Case 2: GitHub repo (contains /)
        else if (project.includes("/")) {
          // Check if already cloned locally
          const repoName = project.split("/")[1];
          const localPath = join(projectsDir, repoName);
          
          if (existsSync(localPath)) {
            currentProject = localPath;
            result += `✅ Proyecto encontrado localmente: ${localPath}\n`;
          } else {
            // Check if exists on GitHub
            if (!commandExists("gh") || !isGhAuthenticated()) {
              return {
                content: [{
                  type: "text",
                  text: `❌ El proyecto ${project} no está clonado y no puedo verificar en GitHub.\n\nUsa \`signoff_check_setup\` para configurar gh CLI.`,
                }],
                isError: true,
              };
            }
            
            if (repoExistsOnGitHub(project)) {
              result += `⚠️ El proyecto ${project} existe en GitHub pero no está clonado.\n\n`;
              result += `¿Quieres clonarlo? Usa:\n`;
              result += `\`signoff_clone_project\` con \`repo: "${project}"\`\n`;
              return { content: [{ type: "text", text: result }] };
            } else {
              return {
                content: [{
                  type: "text",
                  text: `❌ No se encontró el repositorio: ${project}\n\nVerifica que el nombre sea correcto (formato: owner/repo).`,
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
            result += `✅ Proyecto seleccionado: ${localPath}\n`;
          } else {
            return {
              content: [{
                type: "text",
                text: `❌ No se encontró el proyecto: ${project}\n\nProyectos locales están en: ${projectsDir}\n\nUsa \`signoff_list_projects\` para ver proyectos disponibles.`,
              }],
              isError: true,
            };
          }
        }
        
        // Show project status
        const hasGovernance = governanceExists();
        result += `**Governance:** ${hasGovernance ? "✅ Configurado" : "⚠️ No configurado"}\n`;
        
        if (!hasGovernance) {
          result += `\n**Siguiente paso:** Usa \`signoff_setup_governance\` para configurar los leads.\n`;
        } else {
          result += `\n**Siguiente paso:** Usa \`signoff_status\` para ver el estado del proyecto.\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }
      
      case "signoff_clone_project": {
        if (!commandExists("gh")) {
          return {
            content: [{
              type: "text",
              text: "❌ gh CLI no está instalado. Usa `signoff_check_setup` primero.",
            }],
            isError: true,
          };
        }
        
        if (!isGhAuthenticated()) {
          return {
            content: [{
              type: "text",
              text: "❌ No estás autenticado en GitHub. Usa `signoff_authenticate` primero.",
            }],
            isError: true,
          };
        }
        
        const repo = args.repo;
        const folderName = args.folder_name || repo.split("/")[1];
        const targetDir = join(projectsDir, folderName);
        
        // Check if already exists
        if (existsSync(targetDir)) {
          return {
            content: [{
              type: "text",
              text: `⚠️ El directorio ya existe: ${targetDir}\n\nUsa \`signoff_select_project\` con \`project: "${folderName}"\` para seleccionarlo.`,
            }],
          };
        }
        
        // Check if repo exists on GitHub
        if (!repoExistsOnGitHub(repo)) {
          return {
            content: [{
              type: "text",
              text: `❌ No se encontró el repositorio: ${repo}\n\nVerifica que el nombre sea correcto y que tengas acceso.`,
            }],
            isError: true,
          };
        }
        
        // Clone
        let result = `## Clonando ${repo}\n\n`;
        result += `Destino: ${targetDir}\n\n`;
        
        const cloneResult = cloneRepo(repo, targetDir);
        
        if (cloneResult.success) {
          currentProject = targetDir;
          result += `✅ Clonado exitosamente!\n\n`;
          result += `**Proyecto activo:** ${targetDir}\n`;
          
          const hasGovernance = governanceExists();
          result += `**Governance:** ${hasGovernance ? "✅ Configurado" : "⚠️ No configurado"}\n`;
          
          if (!hasGovernance) {
            result += `\n**Siguiente paso:** Usa \`signoff_setup_governance\` para configurar los leads.\n`;
          }
        } else {
          result += `❌ Error al clonar: ${cloneResult.error}\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }
      
      // ===== WORKFLOW TOOLS =====
      case "signoff_status": {
        const projectRoot = getProjectRoot();
        let result = `## Estado del Signoff Flow\n\n`;
        
        if (!projectRoot) {
          result += `❌ No hay proyecto seleccionado.\n\n`;
          result += `Usa \`signoff_select_project\` para seleccionar un proyecto.\n`;
          return { content: [{ type: "text", text: result }] };
        }
        
        result += `**Proyecto:** ${projectRoot}\n\n`;
        
        const hasGovernance = governanceExists();
        result += `**Governance:** ${hasGovernance ? "✅ Configurado" : "❌ No configurado"}\n\n`;
        
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
              text: "❌ No hay proyecto seleccionado. Usa `signoff_select_project` primero.",
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
            text: `✅ Governance configurado!\n\n**Path:** ${govPath}\n**Jira Project:** ${args.jira_project_key}\n**BA Leads:** ${args.ba_leads.join(", ")}\n**Design Leads:** ${args.design_leads.join(", ")}\n**Dev Leads:** ${args.dev_leads.join(", ")}\n\nPuedes crear iniciativas con \`signoff_new_initiative\`.`,
          }],
        };
      }

      case "signoff_new_initiative": {
        if (!getProjectRoot()) {
          return {
            content: [{
              type: "text",
              text: "❌ No hay proyecto seleccionado. Usa `signoff_select_project` primero.",
            }],
            isError: true,
          };
        }
        
        if (!governanceExists()) {
          return {
            content: [{
              type: "text",
              text: "❌ Governance no configurado. Usa `signoff_setup_governance` primero.",
            }],
          };
        }
        
        if (initiativeExists(args.key)) {
          return {
            content: [{
              type: "text",
              text: `❌ La iniciativa ${args.key} ya existe. Usa \`signoff_advance\` para continuar.`,
            }],
          };
        }
        
        const result = createInitiative(args.key, args.title);
        
        return {
          content: [{
            type: "text",
            text: `✅ Iniciativa creada!\n\n**Key:** ${result.key}\n**Título:** ${result.title}\n**Path:** ${result.path}\n**Paso actual:** prd\n\nSiguiente: Usa \`signoff_advance\` para crear el artefacto PRD y PR.`,
          }],
        };
      }

      case "signoff_advance": {
        if (!initiativeExists(args.key)) {
          return {
            content: [{
              type: "text",
              text: `❌ Iniciativa ${args.key} no encontrada. Créala con \`signoff_new_initiative\`.`,
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
              text: `❌ Paso desconocido: ${currentStep}`,
            }],
          };
        }
        
        if (stepIndex >= ARTIFACTS.length - 1 && currentStep === "readiness") {
          return {
            content: [{
              type: "text",
              text: `✅ La iniciativa ${args.key} está completa! Todos los artefactos han sido firmados.`,
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
            text: `✅ Artefacto creado!\n\n**Iniciativa:** ${args.key}\n**Paso:** ${currentStep.toUpperCase()}\n**Artefacto:** ${artifactPath}\n**Signoffs requeridos:** ${groups.join(", ")}\n\n**Siguientes pasos:**\n1. Crear PR en GitHub para branch \`bmad/${args.key}/${currentStep}\`\n2. Crear tickets Jira con \`signoff_create_jira_tickets\`\n3. Solicitar reviews de los leads\n4. Cuando el PR se mergee, ejecuta \`signoff_advance\` de nuevo`,
          }],
        };
      }

      case "signoff_create_jira_tickets": {
        const groups = ARTIFACT_GROUPS[args.artifact];
        if (!groups) {
          return {
            content: [{
              type: "text",
              text: `❌ Artefacto desconocido: ${args.artifact}. Válidos: ${ARTIFACTS.join(", ")}`,
            }],
          };
        }
        
        const governance = loadGovernance();
        const jiraProject = governance?.jira?.project_key || "UNKNOWN";
        
        let result = `## Tickets Jira a Crear\n\n`;
        result += `Usa el MCP de Atlassian para crear estos tickets:\n\n`;
        
        for (const group of groups) {
          result += `### ${group.toUpperCase()} Signoff\n`;
          result += `- **Summary:** \`[BMAD][${args.key}][${args.artifact}] Signoff requerido — ${group.toUpperCase()}\`\n`;
          result += `- **Project:** ${jiraProject}\n`;
          result += `- **Type:** Task\n`;
          result += `- **Labels:** bmad, initiative-${args.key}, artifact-${args.artifact}, group-${group}\n`;
          result += `- **Description:**\n\`\`\`\nBMAD signoff solicitado (lead-only).\n\nIniciativa: ${args.key}\nArtefacto: ${args.artifact.toUpperCase()}\nGrupo: ${group.toUpperCase()}\n\nPR: ${args.pr_url || "(pendiente)"}\n\nAcción: Aprueba el PR para dar signoff.\n\`\`\`\n\n`;
        }
        
        return { content: [{ type: "text", text: result }] };
      }

      default:
        return {
          content: [{
            type: "text",
            text: `Herramienta desconocida: ${name}`,
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
