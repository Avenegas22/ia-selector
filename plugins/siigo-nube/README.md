# Siigo Nube para Claude

Conecta Claude con la contabilidad de tu empresa en **Siigo Nube** (Colombia). Pregúntale quién te debe, pídele el balance de prueba del mes o dile "hazle una factura a Acme por 10 horas de consultoría" — Claude consulta Siigo, te muestra la factura con sus totales y solo la crea cuando tú dices que sí.

Funciona en **Claude Desktop** (un archivo, doble clic) y en **Claude Code** (plugin).

---

## Instalar en Claude Desktop — para cualquier persona

1. **Descarga** [`siigo-nube.mcpb`](https://github.com/Avenegas22/ia-selector/releases/latest/download/siigo-nube.mcpb).
2. **Ábrelo** con doble clic (o arrástralo a Claude Desktop → Configuración → Extensiones). Claude muestra qué hace la extensión y pide confirmar.
3. **Completa los 3 datos de Siigo** (ver abajo cómo obtenerlos): usuario API, access key y Partner-Id. Activa *Modo solo lectura* si solo quieres consultar.
4. Abre un chat nuevo y escribe: *"Verifica mi conexión con Siigo"*.

Requisito: Claude Desktop actualizado en Mac o Windows.

## Instalar en Claude Code

```
/plugin marketplace add Avenegas22/ia-selector
/plugin install siigo-nube@adaptative
```

Claude Code pide los mismos 3 datos al instalar. Para cambiarlos después: `/plugin configure siigo-nube@adaptative`. Requiere Node 18+.

Comandos que agrega: `/siigo-nube:configurar`, `/siigo-nube:facturar`, `/siigo-nube:cartera`, `/siigo-nube:cierre-mes`, y el subagente `analista-siigo` (solo lectura).

---

## Cómo obtener las credenciales en Siigo Nube

Necesitas rol **administrador** y un plan de Siigo Nube que permita integraciones.

1. Siigo Nube → engranaje → **Alianzas e integraciones** → **Configuraciones e integraciones** → **Credenciales de integración a plataformas digitales (Siigo API)**.
2. Completa los datos de contacto. Siigo te muestra el **usuario API** (un correo) y el **access key**.
3. En la misma pantalla: **Añadir aplicación** → ponle un nombre (p. ej. `adaptativeClaude`) → **Guardar cambios**. Siigo te asigna el **Partner-Id**. Solo letras y números: sin espacios, guiones ni tildes.

> "Restablecer credenciales" genera un access key nuevo y desactiva el anterior: si lo haces, actualízalo también en Claude.

## Qué puede hacer

| Pídele… | Qué pasa |
|---|---|
| "¿Quién me debe y cuánto está vencido?" | Cartera por edades (por vencer, 1–30, 31–60, 61–90, +90) con los clientes que más deben |
| "¿Cuánto le debemos a proveedores?" | Cuentas por pagar por proveedor y edad |
| "Balance de prueba de enero a octubre" | Genera el Excel de Siigo y lo guarda en Descargas |
| "Facturas de Acme de este año" | Lista facturas con total, saldo y estado DIAN |
| "Descarga el PDF de la FV-1-457" | Guarda el PDF en Descargas |
| "Hazle factura a 900123456 por 2 SRV-01 a $500.000" | Vista previa con IVA y total → tú confirmas → se crea y se envía a la DIAN |
| "Crea el cliente …" / "Crea el producto …" | Calcula el dígito de verificación del NIT; confirma antes de crear |
| "Cierre de octubre" | Paquete de cierre: balance de prueba, facturación, cartera y cuentas por pagar con alertas |

## Seguridad

- **Tus credenciales no salen de tu computador.** Se guardan cifradas en el llavero del sistema y solo viajan entre tu equipo y `api.siigo.com`. Ni adaptative. ni nadie más las ve.
- **Nada se factura sin tu sí.** Crear una factura es un proceso en dos pasos: vista previa con los totales calculados → aprobación explícita → creación. Lo que se envía es exactamente lo que aprobaste, y un reintento no duplica la factura.
- **Modo solo lectura**: desactiva por completo las herramientas que crean registros.
- Claude Desktop y Claude Code piden permiso antes de usar cada herramienta (puedes aprobar las de consulta de forma permanente).

## Límites de esta versión (0.1)

- Facturas en COP con IVA e Impoconsumo. Si un producto lleva retenciones (Retefuente, ReteIVA, ReteICA), la vista previa lo rechaza: esa factura se crea directamente en Siigo.
- Aún no crea notas crédito, recibos de caja ni comprobantes contables (sí los consulta).
- Siigo no expone estado de resultados ni balance general por API.
- Siigo permite 100 consultas por minuto por empresa; los informes de cartera en empresas con miles de facturas pueden tardar.

---

## Para desarrolladores

Servidor MCP en Node sin dependencias (`server/`), probado de punta a punta contra un Siigo simulado.

```bash
node --test test/*.test.mjs        # pruebas
node scripts/build-mcpb.mjs        # genera dist/siigo-nube.mcpb
claude plugin validate . --strict  # valida el plugin
```

Variables del servidor: `SIIGO_USERNAME`, `SIIGO_ACCESS_KEY`, `SIIGO_PARTNER_ID` (obligatorias), `SIIGO_READ_ONLY`, `SIIGO_OUTPUT_DIR`, `SIIGO_BASE_URL`.

Publicar una versión: sube `version` en `.claude-plugin/plugin.json` (y `VERSION` en `server/index.mjs`), genera el `.mcpb` y adjúntalo como `siigo-nube.mcpb` a un release de GitHub.

Hecho por [adaptative.](https://adaptativeos.com) — Licencia MIT. No es un producto oficial de Siigo S.A.S.
