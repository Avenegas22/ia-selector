---
name: configurar
description: Guía paso a paso para conectar Siigo Nube — obtener usuario API, access key y Partner-Id dentro de Siigo y verificar la conexión. Úsala cuando el usuario quiera configurar o reconfigurar Siigo, o cuando siigo_status reporte credenciales faltantes, Partner-Id inválido o error de autenticación.
argument-hint: "[verificar]"
allowed-tools: mcp__plugin_siigo-nube_siigo__siigo_status
---

# Configurar la conexión con Siigo Nube

Objetivo: dejar el conector autenticado contra `api.siigo.com` con las credenciales **de la empresa del usuario**.

## 1. Diagnóstico

Llama `siigo_status`.

- `conectado: true` → muestra los tipos de factura activos, confirma que todo quedó listo y termina.
- `problemas_configuracion` con elementos → ve al paso 2 y explica solo lo que falte.
- Error HTTP 401 en `/auth` → usuario API o access key incorrectos (paso 2).
- `invalid_partner_id` o `header_required` → Partner-Id mal formado o no registrado (paso 2, punto 3).

## 2. Cómo obtener las credenciales en Siigo Nube

Requiere rol **administrador** en Siigo Nube y un plan que permita integraciones (Siigo indica Emprendedor, Profesional independiente o Premium; si el menú no aparece, es el plan).

1. En Siigo Nube: ícono de engranaje → **Alianzas e integraciones** → **Configuraciones e integraciones** → **Credenciales de integración a plataformas digitales (Siigo API)**. (En versiones anteriores: menú **Alianzas → Mi credencial API**).
2. Diligencia los datos de contacto del desarrollador. Siigo muestra el **usuario API** (un correo) y el **access key**. "Restablecer credenciales" genera un access key nuevo e invalida el anterior.
3. **Partner-Id**: en la misma pantalla, **Añadir aplicación** → escribe un nombre para la integración (p. ej. `adaptativeClaude`) → **Guardar cambios**. Siigo asigna el Partner-Id. Reglas: 3–100 caracteres alfanuméricos, sin espacios, guiones ni tildes; nombres genéricos como "prueba" o "sandbox" se bloquean; máximo 5 aplicaciones por cuenta.

## 3. Dónde se ingresan

- **Claude Code**: `/plugin configure siigo-nube@adaptative` (o al instalar el plugin). El access key se guarda cifrado en el almacenamiento seguro del sistema, no en `settings.json`.
- **Claude Desktop** (extensión `.mcpb`): Configuración → Extensiones → Siigo Nube → Configurar.

Después de guardar, pide al usuario reiniciar la sesión (Claude Code: `/reload-plugins`) y vuelve a llamar `siigo_status`.

## Reglas

- Nunca pidas que pegue el access key en el chat. Siempre se ingresa en el formulario de configuración.
- Si el usuario solo quiere consultar, recomienda activar **Modo solo lectura**.
- Siigo bloquea temporalmente usuarios API con más de 80% de llamadas fallidas en 7 días: no repitas intentos de autenticación fallidos en bucle; corrige primero la configuración.
