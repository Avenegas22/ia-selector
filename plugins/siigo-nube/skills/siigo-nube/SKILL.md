---
name: siigo-nube
description: Conocimiento de referencia para operar Siigo Nube vía API — tipos de documento, identificaciones, impuestos, códigos de error y límites. Úsala siempre que vayas a usar las herramientas siigo_* o el usuario pregunte por datos de su contabilidad en Siigo (clientes, productos, facturas, notas crédito, recibos, comprobantes, compras).
user-invocable: false
---

# Siigo Nube — referencia operativa

## Convenciones

- Montos en **COP**. Fechas `AAAA-MM-DD`, hora Colombia (UTC−5).
- Identificaciones **sin dígito de verificación** (`900123456`, no `900123456-7`). Las herramientas limpian puntos y DV, pero sé explícito.
- `branch_office` (sucursal) es 0 salvo que el tercero tenga varias sedes.
- Los ids de documentos, clientes y productos son GUID; los de catálogos (tipos de documento, impuestos, formas de pago, vendedores) son enteros.

## Tipos de documento (`document_type`)

FV factura de venta · NC nota crédito · RC recibo de caja · FC factura de compra · CC comprobante contable · DS documento soporte.

## Tipos de identificación (`id_type`)

13 cédula · 31 NIT · 22 cédula de extranjería · 41 pasaporte · 42 doc. extranjero · 12 tarjeta de identidad · 11 registro civil · 47 PEP · 48 PPT · 50 NIT de otro país.

Responsabilidades fiscales: R-99-PN (no aplica, por defecto) · O-13 gran contribuyente · O-15 autorretenedor · O-23 agente de retención IVA · O-47 régimen simple.

Ciudades: código DANE de 5 dígitos; los 2 primeros son el departamento (Bogotá 11001, Medellín 05001, Cali 76001, Barranquilla 08001, Bucaramanga 68001, Cartagena 13001).

## Qué herramienta usar

| Necesidad | Herramienta |
|---|---|
| ¿Funciona la conexión? | `siigo_status` |
| Buscar cliente/proveedor | `siigo_find_customers` (por identificación es 1 llamada; por texto recorre todo) |
| Buscar producto | `siigo_find_products` |
| Facturas, NC, recibos, comprobantes, compras | `siigo_list_documents` / `siigo_get_document` |
| PDF de factura o NC | `siigo_download_pdf` |
| Ids de configuración | `siigo_catalog` |
| Cartera por edades | `siigo_accounts_receivable` |
| Cuentas por pagar | `siigo_accounts_payable` |
| Balance de prueba (Excel) | `siigo_trial_balance` |
| Cualquier otro GET | `siigo_api_get` (p. ej. `/v1/invoices/{id}/stamp/errors`) |
| Facturar | `siigo_preview_invoice` → aprobación → `siigo_create_invoice` |

## Límites que importan

- **100 llamadas/minuto** por empresa (10/min en ambiente de pruebas). Prefiere consultas puntuales a barridos.
- Siigo **bloquea temporalmente** al usuario API si más del 80% de sus llamadas fallan en 7 días: si una llamada falla por un dato, corrige el dato antes de reintentar; no reintentes a ciegas.
- Siigo no expone estado de resultados ni balance general por API; sí balance de prueba (Excel) y cuentas por pagar.

## Errores frecuentes

| Código | Qué significa | Qué hacer |
|---|---|---|
| `invalid_partner_id` / `header_required` | Partner-Id mal formado o no registrado | skill `configurar` |
| `unauthorized` | Credenciales inválidas | skill `configurar` |
| `parameter_required` | Falta un campo | lee `Params` y pídele el dato al usuario |
| `invalid_total_payments` | Pagos ≠ total | genera una vista previa nueva |
| `document_settings` | Tipo de documento sin resolución DIAN vigente | revisar la numeración en Siigo |
| `already_exists` | El tercero/producto ya existe | búscalo y úsalo |
| `requests_limit` | Límite de 100/min | espera un minuto |
| `blocked_transactions` | Periodo contable cerrado | cambiar fecha o reabrir en Siigo |
