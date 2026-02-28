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

// CALCULAR DISTANCIA GOOGLE
async function calcularDistancia(inicio, destino) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY) {
    console.error("❌ ERROR: GOOGLE_MAPS_BACKEND_KEY no está configurada");
    return 8.5; // Distancia de prueba para desarrollo
  }
  
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(inicio)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  
  try {
    console.log("🔍 Calculando distancia entre:", inicio, "y", destino);
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status !== "OK") {
      console.error("❌ Google Directions API error:", data.error_message || data.status);
      return 8.5; // Distancia de prueba
    }
    
    const distancia = data.routes?.[0]?.legs?.[0]?.distance?.value;
    if (distancia) {
      const km = distancia / 1000;
      console.log("✅ Distancia calculada:", km.toFixed(2), "km");
      return km;
    }
    return 8.5;
  } catch (err) {
    console.error("❌ Error en Google Directions API:", err.message);
    return 8.5; // Distancia de prueba
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

// ENVIAR CORREOS (CLIENTE Y COPIA)
async function enviarCorreos(cliente, cotizacion) {
  console.log("📧 Iniciando envío de correos...");
  console.log("📧 Cliente:", cliente);
  console.log("📧 Cotización:", cotizacion);
  
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
      console.error("❌ No se encuentra correotemplate.html");
      // Template de emergencia
      htmlTemplate = `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial; padding: 20px;">
          <h2>🚀 TuMotoExpress.cl</h2>
          <p>Hola {{nombre}},</p>
          <p>Tu cotización:</p>
          <p><strong>Origen:</strong> {{origen}}<br>
          <strong>Destino:</strong> {{destino}}<br>
          <strong>Distancia:</strong> {{distancia}} km<br>
          <strong>Total:</strong> ${{total}}</p>
          <p>{{mensajeHorario}}</p>
        </body>
        </html>
      `;
    }

    // Formatear números
    const formatearNumero = (num) => {
      if (!num && num !== 0) return "0";
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    };

    // Procesar template
    let htmlCliente = htmlTemplate
      .replace(/{{nombre}}/g, cliente.nombre || "Cliente")
      .replace(/{{origen}}/g, cotizacion.inicio || "")
      .replace(/{{destino}}/g, cotizacion.destino || "")
      .replace(/{{distancia}}/g, cotizacion.distancia_km ? cotizacion.distancia_km.toFixed(2) : "0")
      .replace(/{{neto}}/g, formatearNumero(cotizacion.neto))
      .replace(/{{iva}}/g, formatearNumero(cotizacion.iva))
      .replace(/{{total}}/g, formatearNumero(cotizacion.total))
      .replace(/{{telefono}}/g, cliente.telefono || "")
      .replace(/{{mensajeHorario}}/g, obtenerMensajeHoraEstimado());

    // Procesar descuento condicional
    if (cotizacion.descuentoValor && cotizacion.descuentoValor > 0) {
      htmlCliente = htmlCliente
        .replace(/{{#if descuento}}/g, '')
        .replace(/{{\/if}}/g, '')
        .replace(/{{descuento}}/g, formatearNumero(cotizacion.descuentoValor));
    } else {
      // Eliminar bloque de descuento
      htmlCliente = htmlCliente.replace(/\{\{#if descuento\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    // Enviar al CLIENTE
    console.log("📧 Enviando a CLIENTE:", cliente.correo);
    const resultCliente = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: cliente.correo,
      subject: `🚀 Tu cotización en TuMotoExpress.cl - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });
    console.log("✅ Correo enviado a cliente:", resultCliente);

    // Enviar COPIA a nosotros
    console.log("📧 Enviando COPIA a contacto@tumotoexpress.cl");
    const resultCopia = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: ["contacto@tumotoexpress.cl"],
      subject: `📊 COPIA: Cotización para ${cliente.nombre || "cliente"} - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });
    console.log("✅ Copia enviada a interno:", resultCopia);

    return true;
  } catch (err) {
    console.error("❌ Error enviando correos:", err.message);
    console.error("❌ Error completo:", err);
    return false;
  }
}

// ENDPOINT COTIZAR
app.post("/cotizar", async (req, res) => {
  console.log("📩 POST /cotizar recibido");
  console.log("📩 Body:", req.body);
  
  try {
    const { inicio, destino, cupon, nombre, correo, telefono } = req.body;

    if (!inicio || !destino) {
      return res.status(400).json({ error: "Faltan datos de origen o destino" });
    }

    // Calcular distancia
    const distancia_km = await calcularDistancia(inicio, destino);
    if (!distancia_km) {
      return res.status(400).json({ 
        error: "No se pudo calcular la distancia. Usaremos tarifa estimada.",
        distancia_km: 8.5
      });
    }

    // Calcular precio
    const resultado = calcularPrecio(distancia_km, cupon || "");
    
    // Preparar respuesta
    const respuesta = {
      inicio,
      destino,
      distancia_km,
      ...resultado
    };

    console.log("✅ Cotización calculada:", respuesta);
    
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

// ENDPOINT DE PRUEBA PARA CORREOS
app.post("/test-email", async (req, res) => {
  try {
    const testCliente = {
      nombre: "Test",
      correo: "contacto@tumotoexpress.cl", // Cambia por tu correo para prueba
      telefono: "912345678"
    };
    
    const testCotizacion = {
      inicio: "Av. Providencia 123",
      destino: "Av. Las Condes 456",
      distancia_km: 8.5,
      neto: 8500,
      descuentoValor: 850,
      iva: 1453,
      total: 9103
    };

    const result = await enviarCorreos(testCliente, testCotizacion);
    res.json({ success: result, message: "Correos de prueba enviados" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`📧 Resend API Key configurada: ${process.env.RESEND_API_KEY ? "SÍ" : "NO"}`);
  console.log(`📍 Google Maps Key configurada: ${process.env.GOOGLE_MAPS_BACKEND_KEY ? "SÍ" : "NO"}`);
});