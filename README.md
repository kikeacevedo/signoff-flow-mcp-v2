# Signoff Flow MCP Server v2.0

Servidor MCP para gestionar flujos de signoff con **onboarding automático** para usuarios no técnicos.

## Novedades en v2.0

- **Instalación automática de gh CLI** - Si no está instalado, se instala automáticamente
- **Flujo de onboarding guiado** - El usuario es guiado paso a paso
- **Gestión de proyectos** - Lista, clona y selecciona proyectos desde GitHub
- **Soporte multi-proyecto** - Trabaja con diferentes proyectos sin reconfigurar

## Flujo de Uso

```
┌─────────────────────────────────────────────────────────────┐
│  1. signoff_check_setup                                     │
│     "¿Está todo listo?"                                     │
│     → Verifica/instala gh CLI                               │
│     → Verifica autenticación                                │
├─────────────────────────────────────────────────────────────┤
│  2. signoff_authenticate (si es necesario)                  │
│     "Necesito conectarme a GitHub"                          │
│     → Guía el proceso de login                              │
├─────────────────────────────────────────────────────────────┤
│  3. signoff_list_projects                                   │
│     "¿En qué proyectos puedo trabajar?"                     │
│     → Muestra proyectos locales y remotos                   │
├─────────────────────────────────────────────────────────────┤
│  4. signoff_select_project / signoff_clone_project          │
│     "Quiero trabajar en X proyecto"                         │
│     → Selecciona o clona el proyecto                        │
├─────────────────────────────────────────────────────────────┤
│  5. signoff_status / signoff_setup_governance               │
│     "¿Cómo está configurado el proyecto?"                   │
│     → Muestra o configura governance                        │
├─────────────────────────────────────────────────────────────┤
│  6. signoff_new_initiative / signoff_advance                │
│     "Crear/avanzar una iniciativa"                          │
│     → Gestiona el flujo de signoffs                         │
└─────────────────────────────────────────────────────────────┘
```

## Herramientas Disponibles

### Setup
| Tool | Descripción |
|------|-------------|
| `signoff_check_setup` | Verifica el entorno (gh CLI, autenticación). **Llamar siempre primero.** |
| `signoff_authenticate` | Guía el proceso de autenticación en GitHub |

### Gestión de Proyectos
| Tool | Descripción |
|------|-------------|
| `signoff_list_projects` | Lista proyectos locales y de GitHub |
| `signoff_select_project` | Selecciona un proyecto para trabajar |
| `signoff_clone_project` | Clona un repositorio de GitHub |

### Workflow
| Tool | Descripción |
|------|-------------|
| `signoff_status` | Muestra estado del proyecto y governance |
| `signoff_setup_governance` | Configura leads y reglas de signoff |
| `signoff_new_initiative` | Crea una nueva iniciativa |
| `signoff_advance` | Avanza al siguiente paso de la iniciativa |
| `signoff_create_jira_tickets` | Genera tickets de Jira para signoff |

## Instalación

### Requisitos
- Node.js 18+
- macOS o Windows

### Para Claude Desktop

1. Instala las dependencias:
```bash
cd /path/to/signoff-flow-mcp-v2
npm install
```

2. Configura en Claude Desktop (`claude_desktop_config.json`):
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

3. Reinicia Claude Desktop

### Ubicación del archivo de configuración

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## Ejemplo de Conversación

```
Usuario: "Hola, quiero revisar los signoffs de un proyecto"

Claude: [signoff_check_setup]
        "Veo que no tienes gh CLI instalado. Instalando automáticamente...
         ✅ gh CLI instalado!
         
         Ahora necesitas autenticarte en GitHub."

Usuario: "Ok, ¿cómo me autentico?"

Claude: [signoff_authenticate]
        "Abre una terminal y ejecuta: gh auth login
         Sigue las instrucciones..."

Usuario: "Listo, ya me autentiqué"

Claude: [signoff_check_setup]
        "✅ Autenticado como: tu-usuario
         
         ¿En qué proyecto quieres trabajar?"

Usuario: "En HALO/feature-payments"

Claude: [signoff_select_project]
        "El proyecto existe en GitHub pero no está clonado.
         ¿Quieres que lo clone?"

Usuario: "Sí, clónalo"

Claude: [signoff_clone_project]
        "✅ Clonado en ~/signoff-projects/feature-payments
         El proyecto no tiene governance configurado."
```

## Directorio de Proyectos

Por defecto, los proyectos se clonan en:
- **macOS/Linux**: `~/signoff-projects/`
- **Windows**: `C:\Users\<user>\signoff-projects\`

## Licencia

MIT
