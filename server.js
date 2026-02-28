require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { Resend } = require("resend");

// Verificar API key al inicio
if (!process.env.RESEND_API_KEY) {
  console.error("❌ ERROR: RESEND_API_KEY no está configurada en .env");
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(__dirname));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/health",(req,res)=>res.json({status:"OK"}));

// TARIFAS
const TARIFAS_FILE = path.join(__dirname, "tarifas.json");
function leerTarifas() {
  try {
    if (fs.existsSync(TARIFAS_FILE)) {
      return JSON.parse(fs.readFileSync(TARIFAS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error leyendo tarifas.json:", err.message);
  }
  return { 
    tarifa_base: 6000, 
    km_adicional_6_10: 1000, 
    km_adicional_10_mas: 850, 
    cupones: {
      "BIENVENIDA10": 10,
      "DESCUENTO20": 20
    } 
  };
}

let { tarifa_base, km_adicional_6_10, km_adicional_10_mas, cupones } = leerTarifas();
let porcentajeAjuste = 0;

// 🔴 FUNCIÓN MODIFICADA - OBTIENE LA RUTA MÁS CORTA CON TIEMPO
async function calcularDistanciaYTiempo(inicio, destino) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY) {
    console.error("❌ ERROR: GOOGLE_MAPS_BACKEND_KEY no está configurada");
    return { km: 8.5, minutos: 30 };
  }
  
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(inicio)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&alternatives=true&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  
  try {
    console.log("🔍 Calculando ruta entre:", inicio, "y", destino);
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status !== "OK") {
      console.error("❌ Google Directions API error:", data.error_message || data.status);
      return { km: 8.5, minutos: 30 };
    }
    
    // Buscar la ruta con la distancia MÁS CORTA
    if (data.routes && data.routes.length > 0) {
      let rutaMasCorta = data.routes[0];
      let distanciaMinima = rutaMasCorta.legs?.[0]?.distance?.value || Infinity;
      let tiempoMinimo = rutaMasCorta.legs?.[0]?.duration?.value || 0;
      
      // Si hay múltiples rutas, encontrar la de menor distancia
      if (data.routes.length > 1) {
        for (let i = 1; i < data.routes.length; i++) {
          const distanciaActual = data.routes[i].legs?.[0]?.distance?.value || Infinity;
          if (distanciaActual < distanciaMinima) {
            distanciaMinima = distanciaActual;
            tiempoMinimo = data.routes[i].legs?.[0]?.duration?.value || 0;
          }
        }
      }
      
      const km = distanciaMinima / 1000;
      const minutos = Math.round(tiempoMinimo / 60); // Convertir segundos a minutos
      
      console.log(`✅ Ruta más corta: ${km.toFixed(2)} km, ${minutos} min (de ${data.routes.length} ruta(s))`);
      return { km, minutos };
    }
    
    return { km: 8.5, minutos: 30 };
  } catch (err) {
    console.error("❌ Error en Google Directions API:", err.message);
    return { km: 8.5, minutos: 30 };
  }
}

// 🔴 NUEVA FUNCIÓN - CALCULAR RUTA ÓPTIMA PARA MÚLTIPLES DESTINOS
async function calcularRutaOptima(origen, destinos) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY || destinos.length === 0) {
    return [];
  }
  
  try {
    console.log("🔄 Calculando ruta óptima para múltiples destinos");
    
    const resultados = [];
    let origenActual = origen;
    
    // Calcular cada tramo desde el origen actual (que siempre es el punto anterior)
    for (let i = 0; i < destinos.length; i++) {
      console.log(`📍 Calculando tramo ${i + 1}:`, origenActual, "→", destinos[i]);
      
      const { km, minutos } = await calcularDistanciaYTiempo(origenActual, destinos[i]);
      
      resultados.push({
        direccion: destinos[i],
        distancia_km: km,
        tiempo_minutos: minutos
      });
      
      // Actualizar origen para el siguiente tramo (NO - siempre desde origen original)
      // origenActual = destinos[i]; // Esto haría ruta en cadena
      // Mantenemos origenActual = origen para siempre calcular desde el origen original
    }
    
    return resultados;
  } catch (err) {
    console.error("❌ Error calculando ruta óptima:", err);
    return destinos.map(destino => ({
      direccion: destino,
      distancia_km: 8.5,
      tiempo_minutos: 30
    }));
  }
}

// CALCULAR PRECIO
function calcularPrecio(distancia_km, codigo_cupon = "") {
  let neto = 0;
  if (distancia_km <= 6) neto = tarifa_base;
  else if (distancia_km <= 10) neto = Math.round(distancia_km * km_adicional_6_10);
  else neto = Math.round(distancia_km * km_adicional_10_mas);
  
  if (porcentajeAjuste > 0) neto = Math.round(neto * (1 + porcentajeAjuste / 100));

  let descuentoValor = 0, descuentoTexto = "";
  const cuponUpper = codigo_cupon.toUpperCase();
  
  if (cuponUpper && cupones && cupones[cuponUpper]) {
    const porcentaje = cupones[cuponUpper];
    descuentoValor = Math.round(neto * (porcentaje / 100));
    descuentoTexto = `Descuento ${cuponUpper} ${porcentaje}%`;
    console.log(`🎟️ Cupón aplicado: ${cuponUpper}, descuento: $${descuentoValor}`);
  }
  
  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento * 0.19);
  const total = netoConDescuento + iva;
  
  return { neto, descuentoValor, descuentoTexto, iva, total, netoConDescuento };
}

// FUNCIÓN PARA OBTENER MENSAJE DE HORARIO
function obtenerMensajeHoraEstimado() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  const minutos = ahora.getMinutes();
  const diasSemana = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  
  function sumar80Minutos(fecha) {
    return new Date(fecha.getTime() + 80 * 60000);
  }

  if (dia >= 1 && dia <= 4 && hora < 9) {
    return `Gracias por cotizar. Estamos fuera de horario, pero podemos gestionar tu servicio para hoy ${diasSemana[dia]} durante la mañana.`;
  }
  if (dia >= 1 && dia <= 5) {
    if (hora >= 9 && (hora < 15 || (hora === 15 && minutos <= 40))) {
      const fechaEstimado = sumar80Minutos(ahora);
      return `Podemos gestionar tu servicio a partir de las ${fechaEstimado.getHours().toString().padStart(2, '0')}:${fechaEstimado.getMinutes().toString().padStart(2, '0')} hrs.`;
    }
  }
  if (dia >= 1 && dia <= 4 && hora > 15) {
    return `Fuera de horario, podemos gestionar tu servicio para mañana ${diasSemana[dia + 1]} durante la mañana.`;
  }
  return `Podemos gestionar tu servicio el lunes durante la mañana.`;
}

// FUNCIÓN PARA GENERAR CÓDIGO ALFANUMÉRICO ALEATORIO
function generarCodigoCotizacion() {
  const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let codigo = '';
  for (let i = 0; i < 8; i++) {
    codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }
  return codigo;
}

// 🔴 FUNCIÓN MODIFICADA - ENVIAR CORREOS CON MÚLTIPLES DESTINOS
async function enviarCorreos(cliente, cotizacion) {
  console.log("📧 Iniciando envío de correos...");
  console.log("📧 Cliente:", JSON.stringify(cliente, null, 2));
  
  if (!cliente?.correo) {
    console.error("❌ No hay correo del cliente");
    return false;
  }

  // Validar email del cliente
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cliente.correo)) {
    console.error("❌ Email del cliente no válido:", cliente.correo);
    return false;
  }

  try {
    // Leer template
    const templatePath = path.join(__dirname, "correotemplate.html");
    let htmlTemplate = "";
    
    if (fs.existsSync(templatePath)) {
      htmlTemplate = fs.readFileSync(templatePath, "utf8");
      console.log("✅ Template de correo cargado");
    } else {
      console.error("❌ No se encuentra correotemplate.html en:", templatePath);
      return false;
    }

    // GENERAR CÓDIGO ALFANUMÉRICO ALEATORIO
    const codigoCotizacion = generarCodigoCotizacion();
    console.log("🔑 Código de cotización generado:", codigoCotizacion);

    // Formatear números
    const formatearNumero = (num) => {
      if (!num && num !== 0) return "0";
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    };

    // 🔴 CREAR HTML PARA MÚLTIPLES DESTINOS
    let destinosHtml = '';
    if (cotizacion.destinos && cotizacion.destinos.length > 0) {
      destinosHtml = '<div style="margin: 10px 0;">';
      cotizacion.destinos.forEach((dest, index) => {
        destinosHtml += `
          <div style="background: #f5f5f5; padding: 8px; margin: 5px 0; border-left: 3px solid #ff4500;">
            <strong>Destino ${index + 1}:</strong> ${dest.direccion}<br>
            📏 ${dest.distancia_km.toFixed(2)} km | ⏱️ ${dest.tiempo_minutos} min
          </div>
        `;
      });
      destinosHtml += '</div>';
    } else {
      // Fallback a un solo destino
      destinosHtml = `<strong>Destino:</strong> ${cotizacion.destino || cotizacion.destinos?.[0]?.direccion || 'No especificado'}`;
    }

    // Procesar template - INCLUYENDO EL CÓDIGO Y MÚLTIPLES DESTINOS
    let htmlCliente = htmlTemplate
      .replace(/{{nombre}}/g, cliente.nombre || "Cliente")
      .replace(/{{origen}}/g, cotizacion.inicio || "")
      .replace(/{{destino}}/g, destinosHtml) // Reemplazamos destino con el HTML de múltiples destinos
      .replace(/{{distancia}}/g, cotizacion.distancia_total_km ? cotizacion.distancia_total_km.toFixed(2) : "0")
      .replace(/{{neto}}/g, formatearNumero(cotizacion.neto))
      .replace(/{{iva}}/g, formatearNumero(cotizacion.iva))
      .replace(/{{total}}/g, formatearNumero(cotizacion.total))
      .replace(/{{telefono}}/g, cliente.telefono || "")
      .replace(/{{mensajeHorario}}/g, obtenerMensajeHoraEstimado())
      .replace(/{{codigoCotizacion}}/g, codigoCotizacion);

    // Procesar descuento condicional
    if (cotizacion.descuentoValor && cotizacion.descuentoValor > 0) {
      htmlCliente = htmlCliente
        .replace(/{{#if descuento}}/g, '')
        .replace(/{{\/if}}/g, '')
        .replace(/{{descuento}}/g, formatearNumero(cotizacion.descuentoValor));
    } else {
      htmlCliente = htmlCliente.replace(/\{\{#if descuento\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Configurar el remitente con tu dominio verificado
    const fromEmail = "contacto@tumotoexpress.cl";
    
    console.log("📧 Enviando a CLIENTE:", cliente.correo);
    console.log("📧 Desde:", fromEmail);
    
    // Enviar al CLIENTE - CON CÓDIGO EN ASUNTO
    const resultCliente = await resend.emails.send({
      from: fromEmail,
      to: cliente.correo,
      subject: `🚀 Cotización #${codigoCotizacion} - TuMotoExpress.cl - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });
    console.log("✅ Correo enviado a cliente. ID:", resultCliente.id);

    // Esperar un momento entre envíos
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Enviar COPIA a nosotros - CON CÓDIGO EN ASUNTO
    console.log("📧 Enviando COPIA a contacto@tumotoexpress.cl");
    const resultCopia = await resend.emails.send({
      from: fromEmail,
      to: ["contacto@tumotoexpress.cl"],
      subject: `📊 COPIA #${codigoCotizacion}: Cotización para ${cliente.nombre || "cliente"} - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });
    console.log("✅ Copia enviada a interno. ID:", resultCopia.id);

    return true;
  } catch (err) {
    console.error("❌ Error enviando correos:");
    console.error("❌ Mensaje:", err.message);
    if (err.response) {
      console.error("❌ Respuesta de Resend:", err.response.data);
    }
    return false;
  }
}

// 🔴 ENDPOINT COTIZAR MODIFICADO - MANEJA MÚLTIPLES DESTINOS
app.post("/cotizar", async (req, res) => {
  console.log("📩 POST /cotizar recibido");
  console.log("📩 Body:", req.body);
  
  try {
    const { inicio, destinos, cupon, nombre, correo, telefono } = req.body;

    if (!inicio) {
      return res.status(400).json({ error: "Falta la dirección de origen" });
    }

    if (!destinos || !Array.isArray(destinos) || destinos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un destino" });
    }

    // 🔴 Calcular ruta óptima para todos los destinos
    const destinosCalculados = await calcularRutaOptima(inicio, destinos);
    
    // 🔴 Calcular distancia total (suma de todos los tramos desde origen)
    const distancia_total_km = destinosCalculados.reduce((sum, d) => sum + d.distancia_km, 0);
    const tiempo_total_minutos = destinosCalculados.reduce((sum, d) => sum + d.tiempo_minutos, 0);
    
    // Calcular precio basado en distancia total
    const resultado = calcularPrecio(distancia_total_km, cupon || "");
    
    // Preparar respuesta
    const respuesta = {
      inicio,
      destinos: destinosCalculados,
      distancia_total_km,
      tiempo_total_minutos,
      ...resultado
    };

    console.log("✅ Cotización calculada:", respuesta);
    console.log(`✅ Distancia total: ${distancia_total_km.toFixed(2)} km, Tiempo total: ${tiempo_total_minutos} min`);
    
    // Enviar respuesta inmediatamente
    res.json(respuesta);

    // Si hay datos de cliente, enviar correos (en segundo plano)
    if (nombre && correo) {
      console.log("📧 Datos de cliente completos, enviando correos...");
      
      // Enviar sin await para no bloquear la respuesta
      enviarCorreos({ nombre, correo, telefono }, respuesta)
        .then(success => {
          if (success) {
            console.log("✅ Correos enviados exitosamente");
          } else {
            console.log("❌ Fallo al enviar correos");
          }
        })
        .catch(err => {
          console.error("❌ Error en envío de correos:", err);
        });
    } else {
      console.log("📧 No hay datos completos de cliente, no se envían correos");
    }

  } catch (error) {
    console.error("❌ Error en /cotizar:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 🔴 NUEVO ENDPOINT PARA ENVIAR CORREO CON DATOS COMPLETOS
app.post("/enviar-correo", async (req, res) => {
  console.log("📩 POST /enviar-correo recibido");
  
  try {
    const { inicio, destinos, cupon, nombre, correo, telefono, cotizacion } = req.body;
    
    if (!nombre || !correo || !telefono) {
      return res.status(400).json({ error: "Faltan datos del cliente" });
    }
    
    console.log("📧 Enviando correo con cotización existente");
    
    const result = await enviarCorreos({ nombre, correo, telefono }, cotizacion);
    
    if (result) {
      res.json({ success: true, message: "Correo enviado correctamente" });
    } else {
      res.status(500).json({ error: "Error al enviar el correo" });
    }
  } catch (err) {
    console.error("❌ Error en /enviar-correo:", err);
    res.status(500).json({ error: err.message });
  }
});

// ENDPOINT DE PRUEBA PARA CORREOS
app.post("/test-email", async (req, res) => {
  try {
    const { testEmail } = req.body;
    
    const testCliente = {
      nombre: "Cliente de Prueba",
      correo: testEmail || "contacto@tumotoexpress.cl",
      telefono: "912345678"
    };
    
    const testCotizacion = {
      inicio: "Av. Providencia 123, Santiago",
      destinos: [
        { direccion: "Av. Las Condes 456, Santiago", distancia_km: 8.5, tiempo_minutos: 18 },
        { direccion: "Av. Irarrázaval 789, Ñuñoa", distancia_km: 5.2, tiempo_minutos: 12 },
        { direccion: "Av. Vicuña Mackenna 123, Santiago", distancia_km: 6.8, tiempo_minutos: 15 }
      ],
      distancia_total_km: 20.5,
      tiempo_total_minutos: 45,
      neto: 17425,
      descuentoValor: 1742,
      iva: 2980,
      total: 18663
    };

    console.log("🧪 Enviando correo de prueba a:", testCliente.correo);
    const result = await enviarCorreos(testCliente, testCotizacion);
    
    if (result) {
      res.json({ 
        success: true, 
        message: "Correos de prueba enviados correctamente",
        detalles: "Revisa la bandeja de entrada y SPAM"
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: "Error al enviar correos de prueba" 
      });
    }
  } catch (err) {
    console.error("❌ Error en test-email:", err);
    res.status(500).json({ error: err.message });
  }
});

// ENDPOINT PARA VERIFICAR CONFIGURACIÓN
app.get("/check-config", (req, res) => {
  res.json({
    resend_key_configured: !!process.env.RESEND_API_KEY,
    google_maps_configured: !!process.env.GOOGLE_MAPS_BACKEND_KEY,
    from_email: "contacto@tumotoexpress.cl",
    port: PORT
  });
});

// SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`📧 Resend API Key: ${process.env.RESEND_API_KEY ? "✅ Configurada" : "❌ No configurada"}`);
  console.log(`📍 Google Maps Key: ${process.env.GOOGLE_MAPS_BACKEND_KEY ? "✅ Configurada" : "❌ No configurada"}`);
  console.log(`📧 Enviando correos desde: contacto@tumotoexpress.cl`);
  console.log("=".repeat(50));
});