require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================
// CONFIG
// =============================
const WHATSAPP_NUMBER = "56942325524"; // Ej: 56912345678

// =============================
// FUNCIONES
// =============================

// Simula delay tipo chatbot (para endpoint JSON)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Calcula tarifa
function calcularTarifa(distancia_km) {
  let neto = 0;

  if (distancia_km <= 6) {
    neto = 6000;
  } else if (distancia_km <= 10) {
    neto = Math.round(distancia_km * 1000);
  } else {
    neto = Math.round(distancia_km * 900);
  }

  const iva = Math.round(neto * 0.19);
  const total = neto + iva;

  return { neto, iva, total };
}

// =============================
// PÁGINA WEB SIMPLE
// =============================
app.get('/', (req, res) => {
  res.send(`
    <h2>🛵 Cotiza tu envío - TuMotoExpress</h2>
    <form method="POST" action="/cotizar-web">
      <input name="inicio" placeholder="Dirección de inicio" required />
      <br/><br/>
      <input name="destino" placeholder="Dirección de destino" required />
      <br/><br/>
      <button type="submit">Calcular</button>
    </form>
  `);
});

// =============================
// COTIZACIÓN DESDE WEB
// =============================
app.post('/cotizar-web', async (req, res) => {
  const { inicio, destino } = req.body;

  try {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!googleApiKey) {
      return res.send("Error: API Key no configurada.");
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(inicio + ", Chile")}&destinations=${encodeURIComponent(destino + ", Chile")}&key=${googleApiKey}`;

    const response = await fetch(url);
    const data = await response.json();
console.log("Respuesta Google:", JSON.stringify(data, null, 2));
    if (
      data.rows &&
      data.rows[0].elements &&
      data.rows[0].elements[0].status === "OK"
    ) {
      const distancia_km = data.rows[0].elements[0].distance.value / 1000;
      const { neto, iva, total } = calcularTarifa(distancia_km);

      const mensajeWhatsApp = encodeURIComponent(
        `Hola, quiero confirmar este envío:\n\n` +
        `Inicio: ${inicio}\n` +
        `Destino: ${destino}\n` +
        `Distancia: ${distancia_km.toFixed(2)} km\n` +
        `Total: $${total}`
      );

      res.send(`
        <h3>Resultado:</h3>
        <p><strong>Distancia:</strong> ${distancia_km.toFixed(2)} km</p>
        <p><strong>Neto:</strong> $${neto}</p>
        <p><strong>IVA 19%:</strong> $${iva}</p>
        <p><strong>Total:</strong> $${total}</p>
        <br/>
        <a href="https://wa.me/${WHATSAPP_NUMBER}?text=${mensajeWhatsApp}" target="_blank">
          ✅ Confirmar por WhatsApp
        </a>
      `);

    } else {
      res.send("Error calculando distancia.");
    }

  } catch (error) {
    console.error(error);
    res.send("Error del servidor.");
  }
});

// =============================
// ENDPOINT JSON (por si luego conectas bot)
// =============================
app.post('/cotizar', async (req, res) => {
  const { inicio, destino } = req.body;

  try {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!googleApiKey) {
      return res.status(500).json({ error: "API Key no configurada" });
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(inicio + ", Chile")}&destinations=${encodeURIComponent(destino + ", Chile")}&key=${googleApiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (
      data.rows &&
      data.rows[0].elements &&
      data.rows[0].elements[0].status === "OK"
    ) {
      const distancia_km = data.rows[0].elements[0].distance.value / 1000;
      const { neto, iva, total } = calcularTarifa(distancia_km);

      const mensajes = [
        `💰 Calculando cotización...`,
        `📍 Distancia: ${distancia_km.toFixed(2)} km`,
        `💵 Valor del servicio: $${neto}`,
        `🧾 IVA 19%: $${iva}`,
        `💳 Total: $${total}`,
        `1️⃣ Aceptar   2️⃣ Rechazar`
      ];

      for (let i = 0; i < mensajes.length; i++) {
        await delay(500);
      }

      res.json({ distancia_km, neto, iva, total, mensajes });

    } else {
      res.status(400).json({ error: "Error calculando cotización" });
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error Google Maps" });
  }
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));