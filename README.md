# Signoff Flow MCP Server v2.0

MCP server for managing signoff workflows with **automatic onboarding** for non-technical users.

## What's New in v2.0

- **Automatic gh CLI installation** - If not installed, it's installed automatically
- **Guided onboarding flow** - Users are guided step by step
- **Project management** - List, clone and select projects from GitHub
- **Multi-project support** - Work with different projects without reconfiguring

## Usage Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. signoff_check_setup                                     │
│     "Is everything ready?"                                  │
│     → Verifies/installs gh CLI                              │
│     → Verifies authentication                               │
├─────────────────────────────────────────────────────────────┤
│  2. signoff_authenticate (if needed)                        │
│     "I need to connect to GitHub"                           │
│     → Guides the login process                              │
├─────────────────────────────────────────────────────────────┤
│  3. signoff_list_projects                                   │
│     "What projects can I work on?"                          │
│     → Shows local and remote projects                       │
├─────────────────────────────────────────────────────────────┤
│  4. signoff_select_project / signoff_clone_project          │
│     "I want to work on project X"                           │
│     → Selects or clones the project                         │
├─────────────────────────────────────────────────────────────┤
│  5. signoff_status / signoff_setup_governance               │
│     "How is the project configured?"                        │
│     → Shows or configures governance                        │
├─────────────────────────────────────────────────────────────┤
│  6. signoff_new_initiative / signoff_advance                │
│     "Create/advance an initiative"                          │
│     → Manages the signoff workflow                          │
└─────────────────────────────────────────────────────────────┘
```

## Available Tools

### Setup
| Tool | Description |
|------|-------------|
| `signoff_check_setup` | Verify the environment (gh CLI, authentication). **Always call this first.** |
| `signoff_authenticate` | Guide the GitHub authentication process |

### Project Management
| Tool | Description |
|------|-------------|
| `signoff_list_projects` | List local and GitHub projects |
| `signoff_select_project` | Select a project to work with |
| `signoff_clone_project` | Clone a GitHub repository |

### Workflow
| Tool | Description |
|------|-------------|
| `signoff_status` | Show project status and governance |
| `signoff_setup_governance` | Configure leads and signoff rules |
| `signoff_new_initiative` | Create a new initiative |
| `signoff_advance` | Advance to the next step of an initiative |
| `signoff_create_jira_tickets` | Generate Jira tickets for signoff |

## Installation

### Requirements
- Node.js 18+
- macOS or Windows

### For Claude Desktop (MCPB - Recommended)

1. Download the `.mcpb` file from [Releases](https://github.com/kikeacevedo/signoff-flow-mcp-v2/releases)
2. Double-click the file or drag it into Claude Desktop
3. Done!

### Manual Installation

1. Clone this repository:
```bash
git clone https://github.com/kikeacevedo/signoff-flow-mcp-v2.git
cd signoff-flow-mcp-v2
npm install
```

2. Configure in Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "signoff-flow": {
      "command": "node",
      "args": ["/path/to/signoff-flow-mcp-v2/index.js"]
    }
  }
}
```

3. Restart Claude Desktop

### Config File Location

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## Example Conversation

```
User: "Hi, I want to review the signoffs for a project"

Claude: [signoff_check_setup]
        "I see you don't have gh CLI installed. Installing automatically...
         ✅ gh CLI installed!
         
         Now you need to authenticate to GitHub."

User: "Ok, how do I authenticate?"

Claude: [signoff_authenticate]
        "Open a terminal and run: gh auth login
         Follow the prompts..."

User: "Done, I'm authenticated"

Claude: [signoff_check_setup]
        "✅ Authenticated as: your-username
         
         Which project do you want to work on?"

User: "HALO/feature-payments"

Claude: [signoff_select_project]
        "The project exists on GitHub but is not cloned.
         Would you like me to clone it?"

User: "Yes, clone it"

Claude: [signoff_clone_project]
        "✅ Cloned to ~/signoff-projects/feature-payments
         The project doesn't have governance configured yet."
```

## Projects Directory

By default, projects are cloned to:
- **macOS/Linux**: `~/signoff-projects/`
- **Windows**: `C:\Users\<user>\signoff-projects\`

## For Teams (Claude for Teams)

### Admin Allowlist (Recommended)

As an organization Owner:
1. Open Claude Desktop
2. Go to **Admin settings → Connectors → Desktop**
3. Enable the **Allowlist**
4. Upload the `signoff-flow.mcpb` file
5. All team members will see it available automatically

### Direct Share

Share the download link with your team:
```
https://github.com/kikeacevedo/signoff-flow-mcp-v2/releases/latest/download/signoff-flow.mcpb
```

## License

MIT
