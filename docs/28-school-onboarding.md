# Escuela NinjaSoft y onboarding guiado

Documento de referencia para F15. Define una capa de educacion, recorridos guiados y sugerencias configurables desde internal para que cada cliente aprenda NinjaSoft POS segun su rubro, plan, rol y momento de adopcion.

## 1. Principio

La escuela no es una seccion decorativa. Es parte del producto:

- [ ] Reduce tickets de soporte.
- [ ] Acelera la primera venta.
- [ ] Evita errores operativos.
- [ ] Certifica usuarios por rol.
- [ ] Mide adopcion real.
- [ ] Permite a NinjaSoft cambiar recorridos sin deploy.

## 2. Escuela por modulos

Cursos iniciales:

- [ ] Primeros pasos.
- [ ] Cargar productos.
- [ ] Cobrar una venta.
- [ ] Abrir y cerrar caja.
- [ ] Clientes y cuenta corriente.
- [ ] Reportes.
- [ ] Tickets e impresoras.
- [ ] Medios de pago y recargos.
- [ ] Devoluciones/cambios.
- [ ] AFIP y cola fiscal.
- [ ] Heladeria/cafeteria.
- [ ] Peluqueria/servicios.
- [ ] Restaurante, mesas y comandas.
- [ ] Panel internal para staff NinjaSoft.

Cada leccion debe tener:

- [ ] Objetivo claro.
- [ ] Tiempo estimado.
- [ ] Roles destinatarios.
- [ ] Pasos guiados.
- [ ] Capturas o video.
- [ ] Demo interactiva cuando aplique.
- [ ] Errores frecuentes.
- [ ] Checklist de cierre.
- [ ] Mini evaluacion.
- [ ] Links a docs relacionados.

## 3. Arquitectura de contenido

Entidades:

- [ ] Curso.
- [ ] Modulo.
- [ ] Leccion.
- [ ] Paso.
- [ ] Evaluacion.
- [ ] Certificacion.
- [ ] Recurso adjunto.
- [ ] Feedback de usuario.

Metadatos:

- [ ] Plan.
- [ ] Rubro.
- [ ] Rol.
- [ ] Feature flag requerida.
- [ ] Pais.
- [ ] Version de producto.
- [ ] Dificultad.
- [ ] Estado: draft, publicado, archivado.

## 4. Tours y recorridos guiados

Tipos de paso:

- [ ] Tooltip anclado a UI.
- [ ] Spotlight sobre elemento.
- [ ] Modal explicativo.
- [ ] Checklist.
- [ ] Accion obligatoria.
- [ ] Accion opcional.
- [ ] Link a video/leccion.
- [ ] Prueba rapida.

Disparadores:

- [ ] Registro completado.
- [ ] Primer login.
- [ ] Primer ingreso a una pantalla.
- [ ] Tenant sin productos.
- [ ] Tenant sin caja abierta.
- [ ] Primer cierre de caja.
- [ ] Medio de pago sin configurar.
- [ ] Impresora no probada.
- [ ] Trial por vencer.
- [ ] Error repetido.
- [ ] Nueva feature habilitada.

Reglas:

- [ ] No mostrar mas de un tour fuerte por sesion.
- [ ] Permitir posponer.
- [ ] Permitir no volver a mostrar segun criticidad.
- [ ] Reintentar si una tarea clave no se completa.
- [ ] Respetar rol: un cashier no ve configuracion de owner.

## 5. Configuracion desde panel internal

Internal debe permitir:

- [ ] Crear curso.
- [ ] Crear leccion.
- [ ] Crear tour.
- [ ] Editar textos, imagenes, videos y CTAs.
- [ ] Elegir audiencia: plan, rubro, rol, tenant, sucursal, feature flag, estado.
- [ ] Elegir disparador.
- [ ] Definir prioridad.
- [ ] Definir frecuencia y cooldown.
- [ ] Definir expiracion.
- [ ] Publicar/despublicar.
- [ ] Hacer A/B test.
- [ ] Ver preview como rol/tenant.
- [ ] Clonar recorrido.
- [ ] Traducir contenido.
- [ ] Ver metricas.
- [ ] Enviar sugerencia puntual a una cuenta.

## 6. Onboarding por rubro

### Retail general

- [ ] Datos del comercio.
- [ ] Sucursal/caja.
- [ ] Productos o import XLSX.
- [ ] Medios de pago.
- [ ] Ticket.
- [ ] Primer cobro.
- [ ] Cierre de caja.

### Electro / muebles / herramientas

- [ ] Garantia de fabrica.
- [ ] Garantias extendidas.
- [ ] Pedidos de salon.
- [ ] Despacho.
- [ ] Depositos.
- [ ] Series/lotes cuando F14 este activo.

### Heladeria / cafeteria

- [ ] Botones favoritos.
- [ ] Tamanos.
- [ ] Sabores/toppings.
- [ ] Comanda de preparacion.
- [ ] Cobro express.
- [ ] Nombre del cliente.

### Peluqueria / estetica

- [ ] Servicios.
- [ ] Profesionales.
- [ ] Agenda.
- [ ] Comisiones.
- [ ] Senas.
- [ ] Packs/membresias.

### Restaurante / bar

- [ ] Salones.
- [ ] Mesas.
- [ ] Estaciones.
- [ ] Comandas.
- [ ] KDS.
- [ ] Division de cuenta.
- [ ] Delivery/takeaway.

## 7. Checklist de activacion

Checklist dinamico por tenant:

- [ ] Datos legales completos.
- [ ] Rubro elegido.
- [ ] Sucursal creada.
- [ ] Caja creada.
- [ ] Al menos un producto/servicio.
- [ ] Medio de pago activo.
- [ ] Ticket configurado.
- [ ] Impresora probada si corresponde.
- [ ] Usuario invitado.
- [ ] Primera venta de prueba.
- [ ] Primer cierre de caja.
- [ ] AFIP configurado si corresponde.
- [ ] Primer reporte visto.

Estados:

- [ ] Pendiente.
- [ ] En progreso.
- [ ] Completado.
- [ ] Omitido con motivo.
- [ ] Bloqueado.

## 8. Ayuda contextual

Cada pantalla puede mostrar:

- [ ] Articulos sugeridos.
- [ ] Videos cortos.
- [ ] Tour disponible.
- [ ] Preguntas frecuentes.
- [ ] Boton "pedir ayuda".
- [ ] Ultimos errores del usuario con guia.

La ayuda debe filtrarse por:

- [ ] Rol.
- [ ] Rubro.
- [ ] Plan.
- [ ] Feature activa.
- [ ] Estado del tenant.

## 9. Laboratorio/demo segura

Objetivo: practicar sin tocar datos reales.

- [ ] Datos demo por rubro.
- [ ] Caja demo.
- [ ] Stock demo.
- [ ] Cliente demo.
- [ ] Ventas demo.
- [ ] Comandas demo.
- [ ] Devoluciones demo.
- [ ] Reset de laboratorio.
- [ ] Banner visible "Modo practica".
- [ ] Prohibido emitir AFIP real desde laboratorio.

## 10. Certificaciones

Certificaciones iniciales:

- [ ] Cajero basico.
- [ ] Manager retail.
- [ ] Administrador de productos.
- [ ] Caja y arqueo.
- [ ] Gastronomia mesas/comandas.
- [ ] Servicios y agenda.
- [ ] AFIP operador.
- [ ] Staff soporte internal.

Cada certificacion:

- [ ] Tiene prerequisitos.
- [ ] Exige aprobar lecciones.
- [ ] Exige completar flujo practico.
- [ ] Vence opcionalmente si cambia mucho el modulo.
- [ ] Puede ser requerida por tenant para operar ciertas funciones.

## 11. Metricas

Metricas de aprendizaje:

- [ ] Tiempo a primera venta.
- [ ] Tiempo a primera caja cerrada.
- [ ] Curso iniciado/completado.
- [ ] Tour iniciado/completado/abandonado.
- [ ] Paso con mayor abandono.
- [ ] Feedback util/no util.
- [ ] Tickets de soporte por modulo.
- [ ] Errores repetidos antes/despues de sugerencia.
- [ ] Activacion por rubro.

Internal debe poder segmentar por:

- [ ] Plan.
- [ ] Rubro.
- [ ] Provincia.
- [ ] Canal de venta.
- [ ] Staff asignado.
- [ ] Fecha de alta.

## 12. Notificaciones y sugerencias

Las sugerencias deben integrarse con `25-account-notifications.md`.

Tipos:

- [ ] Novedad.
- [ ] Tarea pendiente.
- [ ] Alerta de configuracion.
- [ ] Recomendacion de curso.
- [ ] Feature nueva.
- [ ] Error recurrente.
- [ ] Trial por vencer.
- [ ] Limite cerca.

Canales:

- [ ] Banner in-app.
- [ ] Inbox.
- [ ] Tooltip contextual.
- [ ] Email.
- [ ] WhatsApp futuro.
- [ ] Push futuro.

Guardrails:

- [ ] No saturar al usuario.
- [ ] No bloquear venta salvo riesgo critico.
- [ ] No mostrar sugerencias irrelevantes para el rol.
- [ ] Registrar lectura, click y finalizacion.

## 13. Criterios de cierre

- [ ] Internal crea y publica un tour para un rubro sin deploy.
- [ ] Un tenant nuevo recibe checklist adaptado a su rubro.
- [ ] Un cashier completa una leccion y queda certificado.
- [ ] Una sugerencia aparece por evento, respeta cooldown y registra metricas.
- [ ] Support ve cuentas trabadas y dispara ayuda especifica.
- [ ] El laboratorio permite practicar venta/devolucion/comanda sin afectar datos reales.

