# Brief — Azumo Workspaces

## Contexto

**Azumo Workspaces** es el Bench Challenge de Azumo: construir un prototipo funcional inspirado en Notion y demostrar que se usa Claude Code con competencia para analizar, planificar, programar, probar y revisar.

- **Primera iteración:** de dos a tres días de trabajo.
- **Alcance:** no se busca replicar todo Notion.

## Propósito

- Entregar una aplicación web funcional y desplegada.
- Demostrar un flujo de trabajo disciplinado con Claude Code: primero el PRD, después la planificación y la implementación por tareas pequeñas; cada paso se prueba y revisa con evidencia real.
- Los subagentes, skills y el servidor MCP son herramientas para construir la aplicación. No son el producto final.

## Requisitos obligatorios

| ID | Requisito |
|----|-----------|
| R1 | Google SSO restringido al dominio corporativo autorizado (dominio pendiente de confirmar: ver P1). |
| R2 | Múltiples espacios de trabajo (workspaces). |
| R3 | Miembros y permisos por rol dentro de cada espacio de trabajo. |
| R4 | Páginas con capacidad de vincular o adjuntar archivos (modalidad pendiente: ver P2). |
| R5 | PRD aprobado antes de implementar funcionalidades. |
| R6 | Despliegue en Vercel con cuentas y repositorio autorizados. |

## Propuestas que requieren validación

Todavía no son requisitos. No deben tratarse como aprobadas hasta que el usuario las confirme.

| ID | Propuesta |
|----|-----------|
| PR1 | Crear, consultar, editar y eliminar páginas (CRUD). |
| PR2 | Contenido con formato básico y persistencia. |
| PR3 | Roles Owner, Editor y Viewer. |

## Decisiones pendientes

| ID | Decisión | Estado |
|----|----------|--------|
| P1 | Dominio autorizado para SSO: el acta dice `azumo.com`, pero los invitados usan `azumo.co`. **No se debe elegir uno ni permitir ambos sin confirmación explícita.** | Abierta |
| P2 | Archivos en las páginas: ¿se vinculan, se suben o ambas cosas? | Abierta |
| P3 | Elección y aprobación del stack tecnológico. | Abierta |
| P4 | Cuenta de Vercel y repositorio autorizados. | Abierta |

## Restricciones de trabajo

- No hacer commits, push ni despliegues sin autorización específica.
- No guardar secretos en el repositorio ni usar datos de producción.
- El servidor MCP del proyecto está pendiente de diseño e implementación.
