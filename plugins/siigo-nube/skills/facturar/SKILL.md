---
name: facturar
description: Crea una factura de venta (electrónica) en Siigo Nube con vista previa y confirmación explícita. Úsala cuando el usuario pida facturar, emitir una factura, cobrarle a un cliente por un producto o servicio, o "hazle factura a…".
argument-hint: "[cliente] [productos y cantidades]"
allowed-tools: mcp__plugin_siigo-nube_siigo__siigo_find_customers, mcp__plugin_siigo-nube_siigo__siigo_find_products, mcp__plugin_siigo-nube_siigo__siigo_catalog, mcp__plugin_siigo-nube_siigo__siigo_preview_invoice, mcp__plugin_siigo-nube_siigo__siigo_get_document
---

# Facturar en Siigo Nube

Pedido del usuario: $ARGUMENTS

Una factura electrónica aceptada por la DIAN **no se puede borrar**: solo se corrige con nota crédito. Por eso el flujo es siempre vista previa → aprobación → creación.

## Flujo

1. **Cliente.** `siigo_find_customers` por identificación (sin DV) o por nombre. Si hay varias coincidencias, pregunta cuál. Si no existe, ofrece crearlo con `siigo_create_customer` — pide los datos mínimos (tipo de persona, tipo y número de identificación, nombre o razón social, dirección, ciudad con código DANE, correo) y confírmalos antes de crearlo.
2. **Productos.** `siigo_find_products` por código o nombre. Usa el precio de la lista 1 como sugerencia, pero confirma con el usuario el **precio unitario antes de IVA**. Si el producto tiene `impuesto_incluido: true`, calcula la base (precio ÷ (1 + %IVA)) y díselo.
3. **Vista previa.** `siigo_preview_invoice` con cliente e ítems. Si responde que hay varias opciones de tipo de documento, vendedor o forma de pago, pregúntale al usuario (muestra las opciones tal como vienen) y vuelve a llamar. Si la forma de pago es a crédito, pide la fecha de vencimiento.
4. **Mostrar el resumen** en una tabla: cliente, ítems (cantidad, precio, base, IVA, total), subtotal, impuestos, **total**, forma de pago, vencimiento, si se envía a la DIAN y si se envía por correo. Incluye las `advertencias`.
5. **Pedir confirmación explícita**: "¿Creo esta factura en Siigo y la envío a la DIAN? (sí/no)". Una respuesta ambigua no es un sí.
6. **Crear.** Solo con un sí: `siigo_create_invoice` con el `preview_id`. Si el usuario cambia algo, genera una vista previa nueva — nunca reutilices una vieja.
7. **Reportar**: número (p. ej. FV-1-123), total, estado DIAN, CUFE y enlace público. Si `estado_dian` es `Rejected`, muestra los errores y explica que debe corregirse en Siigo. Ofrece descargar el PDF (`siigo_download_pdf`) o enviarlo por correo (`siigo_email_invoice`, confirmando destinatarios).

## Límites de esta versión

- Calcula IVA e Impoconsumo. Si un producto trae retenciones (Retefuente, ReteIVA, ReteICA), la vista previa lo rechaza: explica que la retención se registra en el recibo de caja o que esa factura se crea directamente en Siigo.
- Una factura electrónica no puede tener fecha anterior a hoy.
- Montos en COP; moneda extranjera no está soportada todavía.
