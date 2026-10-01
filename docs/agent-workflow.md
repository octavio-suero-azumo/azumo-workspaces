# Flujo de trabajo con agentes — Azumo Workspaces

## Visión general

El desarrollo lo dirige un **coordinador**: la conversación principal de Claude Code, usando la skill `azumo-orchestrator`. El coordinador delega el trabajo especializado en cinco subagentes definidos en `.claude/agents/`. Los subagentes **no** delegan en otros subagentes: no tienen la herramienta `Agent`.

Fases, siempre separadas y en este orden: **Investigación → Planificación → Implementación → Pruebas → Revisión.**

## Coordinador (`.claude/skills/azumo-orchestrator/SKILL.md`)

- Lee `CLAUDE.md`, `docs/brief.md`, este documento y `docs/status.md` antes de actuar.
- Identifica qué fase autorizó el usuario y no avanza a la siguiente sin autorización.
- Invoca realmente a los especialistas con la herramienta `Agent`. Nunca inventa sus respuestas.
- Da a cada agente contexto, rutas de archivos relevantes, el resultado esperado y las restricciones.
- Guarda en `docs/` los entregables de los agentes de solo lectura.
- Trabaja por tareas pequeñas. Nunca ejecuta a la vez dos agentes que editan archivos.
- Registra resultados y bloqueos en `docs/status.md`.
- Se detiene después de dos ciclos de corrección sin éxito.
- No da por terminada una tarea solo porque existe código.

## Subagentes

| Agente | Función | Entrada | Resultado | Herramientas (aplicadas por configuración) |
|--------|---------|---------|-----------|------------------------------|
| `researcher` | Investiga documentación oficial y alternativas | Pregunta concreta y archivos de contexto | Fuentes, hallazgos, opciones, conclusiones, riesgos y preguntas | Read, Grep, Glob, WebFetch, WebSearch |
| `architect` | Requisitos, arquitectura, entidades, permisos y tareas | Brief, investigación y alcance aprobado | Propuesta estructurada con IDs trazables | Read, Grep, Glob |
| `developer` | Implementa una tarea aprobada o corrige un defecto | ID de tarea aprobada, PRD, plan y archivos | Archivos modificados, comprobaciones reales y bloqueos | Read, Grep, Glob, Edit, Write, Bash |
| `qa` | Plan de pruebas, escritura de pruebas (si está autorizada) y verificación real | PRD, plan de pruebas y tarea | Casos de prueba y resultados etiquetados como reales, simulados o pendientes de comprobación manual | Read, Grep, Glob, Edit, Write, Bash |
| `reviewer` | Revisa cumplimiento, código, permisos y evidencias | Código, informes y documentos | Observaciones con severidad, recomendaciones y veredicto | Read, Grep, Glob |

### Restricciones aplicadas por herramientas frente a instrucciones de comportamiento

- **Aplicadas por herramientas (campo `tools`):** `researcher`, `architect` y `reviewer` no tienen Edit, Write ni Bash, así que no pueden modificar archivos. Ningún subagente tiene `Agent`, así que ninguno puede delegar. Ninguno usa `bypassPermissions`; todos heredan el modo de permisos de la sesión.
- **Solo instrucciones (dependen del comportamiento del modelo):**
  - `developer` no instala dependencias, no hace commits, push ni despliegues y no se sale del alcance de su tarea.
  - `qa` solo edita archivos de prueba y no modifica código de producción para ocultar fallos.
  - Ninguno de los dos debilita pruebas.

  Estas reglas **no** están bloqueadas técnicamente porque ambos agentes tienen Write, Edit y Bash. Se controlan con los permisos de la sesión (el usuario aprueba cada comando) y con la revisión posterior.

## Aprobación humana obligatoria

1. Resolver cada decisión pendiente: dominio SSO, vincular o subir archivos, stack, y cuenta de Vercel y repositorio.
2. Promover una propuesta (PR1–PR3) a requisito.
3. Aprobar `docs/PRD.md` y `docs/implementation-plan.md` antes de implementar.
4. Autorizar la implementación de cada tarea (o de un lote explícito de tareas).
5. Autorizar la fase de escritura de pruebas.
6. Instalar dependencias, hacer commits, push, desplegar o crear recursos externos.
7. Decidir cómo continuar después de dos ciclos de corrección fallidos.

## Entregables de la fase de planificación (pendientes)

Se generarán cuando se autorice la fase de planificación:

- `docs/PRD.md`
- `docs/architecture.md`
- `docs/implementation-plan.md`
- `docs/test-plan.md`
- `docs/requirements-traceability.md`

## Agente definido frente a agente invocado

- **Definido:** existe su archivo en `.claude/agents/<nombre>.md`. Eso solo demuestra que la configuración existe, **no** que el agente haya trabajado.
- **Invocado realmente:** hay una llamada a la herramienta `Agent` con `subagent_type: <nombre>` en la transcripción de la sesión, con su resultado devuelto, **y** una entrada en `docs/status.md` con «Real invocation: yes», fecha y resumen.
- Si una invocación falla, se registra el error y no se sustituye por una respuesta simulada.

**Estado actual (2026-09-30):** los cinco agentes están definidos y se han **invocado realmente**. La evidencia está en `docs/agent-check.md` y en `docs/status.md`, con sus agentId. El servidor MCP del proyecto existe en `tools/bench-mcp` (ver la sección siguiente).

## Servidor MCP

`tools/bench-mcp` está implementado y registrado en `.mcp.json` con el nombre `bench`. Tiene cinco herramientas: `get_requirements`, `list_tasks`, `upsert_task`, `run_checks` y `get_run_report`.

- **Carga:** las herramientas solo aparecen en una sesión de Claude iniciada después de registrar el servidor.
- **Sin recargar la sesión:** el coordinador lo invoca con el cliente MCP real `tools/bench-mcp/call.mjs`.
- **Evidencias:**
  - reportes de ejecución en `docs/bench/runs/`;
  - registro de tareas en `docs/bench/tasks.json`.
