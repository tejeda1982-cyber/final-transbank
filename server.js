require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Resend } = require('resend');
const { WebpayPlus, Options, Environment } = require("transbank-sdk");

// ✅ Validar variables de entorno críticas
if (!process.env.RESEND_API_KEY) {
  console.error("ERROR: RESEND_API_KEY no está configurada");
  process.exit(1);
}

if (!process.env.GOOGLE_MAPS_API_KEY) {
  console.error("ERROR: GOOGLE_MAPS_API_KEY no está configurada");
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Configurar Transbank
const tx = new WebpayPlus.Transaction(
  new Options(
    process.env.TRANSBANK_COMMERCE_CODE,
    process.env.TRANSBANK_API_KEY,
    process.env.TRANSBANK_ENV === "production"
      ? Environment.Production
      : Environment.Integration
  )
);

// ================================
// CALCULAR DISTANCIA REAL CON GOOGLE MAPS
// ================================
async function calcularDistancia(inicio, destino) {
  if (!inicio?.trim() || !destino?.trim()) {
    console.error("Direcciones inválidas");
    return null;
  }

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(inicio)}&destinations=${encodeURIComponent(destino)}&region=CL&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);

    if (!resp.ok) {
      console.error(`Google Maps error: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const data = await resp.json();

    if (data.rows?.[0]?.elements?.[0]?.status === "OK") {
      return data.rows[0].elements[0].distance.value / 1000; // km
    }

    console.error("Google Maps error:", data.status);
    return null;
  } catch (e) {
    console.error("Error al calcular distancia:", e.message);
    return null;
  }
}

// ================================
// FUNCIÓN HORARIO ESTIMADO
// ================================
function calcularMensajeHorario() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  const minuto = ahora.getMinutes();
  const minutosActuales = hora * 60 + minuto;
  const apertura = 9 * 60;
  const cierre = 17 * 60;
  const limiteRespuesta = 15 * 60 + 40;
  const tiempoRespuesta = 80;

  if (dia === 0) return "Domingo: cotización recibida. Te responderemos el lunes desde las 9:00 AM.";
  if (minutosActuales < apertura) return "Estamos fuera de horario. Te responderemos desde las 9:00 AM.";
  if (minutosActuales > cierre) return "Fuera de horario. Te responderemos mañana desde las 9:00 AM.";
  if (minutosActuales > limiteRespuesta) return "Cotización recibida. Te confirmaremos disponibilidad mañana temprano.";

  const respuesta = new Date(ahora.getTime() + tiempoRespuesta * 60000);
  return `Tiempo estimado de respuesta: ${respuesta.getHours()}:${respuesta.getMinutes().toString().padStart(2, "0")} hrs.`;
}

// ================================
// ENDPOINT COTIZAR
// ================================
app.post("/cotizar", async (req, res) => {
  const { inicio, destino } = req.body;

  if (!inicio?.trim() || !destino?.trim()) {
    return res.status(400).json({ error: "Faltan direcciones válidas" });
  }

  const distancia_km = await calcularDistancia(inicio, destino);

  if (distancia_km === null) {
    return res.status(400).json({ error: "No se pudo calcular distancia" });
  }

  const valor_base = 5000;
  const iva = Math.round(valor_base * 0.19);
  const total = valor_base + iva;

  res.json({
    inicio,
    destino,
    distancia_km,
    valor_base,
    iva,
    total,
    mensajeHorario: calcularMensajeHorario()
  });
});

// ================================
// ENVIAR COTIZACIÓN POR CORREO
// ================================
app.post("/enviar-cotizacion", async (req, res) => {
  const { nombre, telefono, email, distancia_km, valor_base, iva, total, mensajeHorario } = req.body;

  if (!nombre?.trim() || !telefono?.trim() || !email?.trim()) {
    return res.status(400).json({ error: "Faltan datos del cliente" });
  }

  try {
    await resend.emails.send({
      from: "TuMotoExpress <contacto@tumotoexpress.cl>",
      to: email,
      subject: "Cotización TuMotoExpress.cl - Consulta disponibilidad de servicio",
      html: `
        <h2>Cotización TuMotoExpress.cl</h2>
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        <hr>
        <p><strong>Distancia:</strong> ${distancia_km.toFixed(2)} km</p>
        <p><strong>Valor Servicio:</strong> $${valor_base}</p>
        <p><strong>IVA:</strong> $${iva}</p>
        <p><strong>Total:</strong> $${total}</p>
        <hr>
        <p><strong>Disponibilidad:</strong> ${mensajeHorario}</p>
        <p>Gracias por confiar en TuMotoExpress.cl</p>
      `
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error enviando correo:", e.message);
    res.status(500).json({ error: "No se pudo enviar correo" });
  }
});

// ================================
// CREAR TRANSACCIÓN WEBPAY
// ================================
app.post("/crear-transaccion", async (req, res) => {
  const { nombre, telefono, email, distancia_km } = req.body;

  if (!nombre?.trim() || !telefono?.trim() || !email?.trim()) {
    return res.status(400).json({ error: "Faltan datos del cliente" });
  }

  const valor_base = 5000;
  const iva = Math.round(valor_base * 0.19);
  const total_calculado = valor_base + iva;

  const buyOrder = "orden_" + Date.now();
  const sessionId = "sesion_" + Date.now();
  const returnUrl = process.env.BASE_URL + "/confirmacion?email=" + encodeURIComponent(email);

  try {
    const response = await tx.create(buyOrder, sessionId, total_calculado, returnUrl);
    res.json(response);
  } catch (e) {
    console.error("Error creando transacción:", e.message);
    res.status(500).json({ error: "No se pudo crear transacción" });
  }
});

// ================================
// CONFIRMACIÓN WEBPAY
// ================================
app.post("/confirmacion", async (req, res) => {
  const token_ws = req.body.token_ws || req.query.token_ws;
  const clienteEmail = req.query.email;

  if (!token_ws) {
    return res.status(400).json({ error: "token_ws faltante" });
  }

  try {
    const response = await tx.commit(token_ws);

    if (response.status === "AUTHORIZED" && clienteEmail) {
      await resend.emails.send({
        from: "TuMotoExpress.cl <contacto@tumotoexpress.cl>",
        to: clienteEmail,
        subject: "Pago confirmado - TuMotoExpress.cl",
        html: `<h2>Pago confirmado</h2>
               <p>Tu pago fue confirmado exitosamente.</p>
               <p>En unos minutos coordinaremos tu servicio.</p>`
      });
    }
    res.json(response);
  } catch (e) {
    console.error("Error en confirmación Webpay:", e.message);
    res.status(500).json({ error: "No se pudo confirmar pago" });
  }
});

// ================================
// SERVER
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.TRANSBANK_ENV || 'development'}`);
});