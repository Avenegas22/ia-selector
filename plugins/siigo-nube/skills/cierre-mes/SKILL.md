---
name: cierre-mes
description: Arma el paquete de cierre contable de un mes desde Siigo Nube — balance de prueba en Excel, cartera por edades, cuentas por pagar y facturación del periodo — con alertas para revisar. Úsala cuando el usuario pida el cierre de mes, el balance de prueba, cómo quedó el mes o un resumen financiero de un periodo.
argument-hint: "[AAAA-MM]"
allowed-tools: mcp__plugin_siigo-nube_siigo__siigo_trial_balance, mcp__plugin_siigo-nube_siigo__siigo_accounts_receivable, mcp__plugin_siigo-nube_siigo__siigo_accounts_payable, mcp__plugin_siigo-nube_siigo__siigo_list_documents
---

# Cierre de mes

Periodo: $ARGUMENTS (si no se indica, el mes anterior al actual).

## Flujo

1. **Balance de prueba**: `siigo_trial_balance` con el año, `month_start: 1` y `month_end` = mes del cierre (acumulado del año). Siigo lo entrega como Excel: indica la ruta donde quedó descargado. Si el usuario lo pide por tercero, usa `by_third_party: true`.
2. **Facturación del mes**: `siigo_list_documents` tipo `invoices` con `date_start`/`date_end` del mes (pagina si `total_results` > `page_size`). Reporta cantidad de facturas, total facturado y cuántas no están `Accepted` por la DIAN.
3. **Notas crédito del mes**: `siigo_list_documents` tipo `credit_notes` con `created_start`/`created_end`. Reporta cantidad y total.
4. **Cartera al cierre**: `siigo_accounts_receivable` con `as_of` = último día del mes.
5. **Cuentas por pagar al cierre**: `siigo_accounts_payable` con `as_of` = último día del mes.

## Entregable

Un resumen ejecutivo de una página:

| Indicador | Valor |
|---|---|
| Facturación del mes | … |
| Notas crédito | … |
| Cartera total / vencida +60 | … |
| Cuentas por pagar / vencidas | … |
| Facturas no aceptadas por DIAN | … |

Seguido de **Alertas para revisar antes de cerrar**: facturas rechazadas o en borrador, cartera +90 días (provisión), proveedores vencidos, notas crédito inusualmente altas frente a la facturación.

No hagas asientos ni ajustes: este skill solo lee y reporta.
