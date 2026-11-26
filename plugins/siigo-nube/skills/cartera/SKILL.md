---
name: cartera
description: Analiza la cartera (cuentas por cobrar) de Siigo Nube por edades, prioriza a quién cobrar y redacta mensajes de cobro. Úsala cuando el usuario pregunte quién le debe, cuánta cartera vencida tiene, a quién cobrar primero, o pida un informe de cartera o de cuentas por cobrar.
argument-hint: "[fecha de corte AAAA-MM-DD] [cliente]"
allowed-tools: mcp__plugin_siigo-nube_siigo__siigo_accounts_receivable, mcp__plugin_siigo-nube_siigo__siigo_find_customers, mcp__plugin_siigo-nube_siigo__siigo_list_documents, mcp__plugin_siigo-nube_siigo__siigo_get_document
---

# Cartera por edades

Pedido: $ARGUMENTS

## Flujo

1. `siigo_accounts_receivable` (fecha de corte = hoy salvo que el usuario indique otra; filtra por cliente si lo nombra). Siigo no tiene endpoint de cartera: la herramienta recorre las facturas con saldo > 0, así que en empresas grandes puede tardar.
2. Presenta:
   - **Total de cartera** y distribución por edad (por vencer, 1–30, 31–60, 61–90, +90) en una tabla, con el % de cada tramo.
   - **Top clientes por saldo** con su tramo más viejo.
   - **Concentración**: qué % del total suman los 3 primeros clientes.
3. **Prioridad de cobro** — ordena por riesgo, no solo por monto:
   - Primero: +90 días (riesgo de incobrable; sugiere evaluar provisión).
   - Luego: 61–90 y saldos grandes en 31–60.
   - Facturas por vencer en los próximos 7 días: recordatorio preventivo.
4. Si el usuario lo pide, **redacta mensajes de cobro** por cliente (correo o WhatsApp), con número de factura, valor, días de mora y un tono acorde al tramo: cordial (1–30), firme (31–90), formal con fecha límite (+90). Solo redacta; no envíes nada.

## Notas

- Si `busqueda_truncada` es true, dilo y sugiere filtrar por cliente o acortar el rango con `date_start`.
- Los saldos salen del campo `balance` de cada factura en Siigo: si los recibos de caja no están al día en Siigo, la cartera aparecerá inflada. Menciónalo cuando un saldo parezca inconsistente.
- Para reenviar una factura a un cliente usa `siigo_email_invoice`, confirmando primero el destinatario.
