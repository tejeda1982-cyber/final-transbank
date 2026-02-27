require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch"); // versión 2.x
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

// Configuración básica
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => res.json({ status: "OK" }));

// Tarifas
const TARIFAS_FILE = path.join(__dirname, "tarifas.json");
function leerTarifas() {
  try { return JSON.parse(fs.readFileSync(TARIFAS_FILE, "utf8")); }
  catch { return { tarifa_base: 6000, km_adicional_6_10: 1000, km_adicional_10_mas: 850, cupones: {} }; }
}
let { tarifa_base, km_adicional_6_10, km_adicional_10_mas, cupones } = leerTarifas();
let porcentajeAjuste = 0;

// Calcular distancia Google
async function calcularDistancia(inicio, destino) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(inicio)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "OK") { console.error("Google Directions API error:", data.error_message || data.status); return null; }
    return data.routes?.[0]?.legs?.[0]?.distance?.value ? data.routes[0].legs[0].distance.value / 1000 : null;
  } catch (err) { console.error("Error fetch Google Directions API:", err); return null; }
}

// Calcular precio
function calcularPrecio(distancia_km, codigo_cupon = "") {
  let neto = distancia_km <= 6 ? tarifa_base : distancia_km <= 10 ? Math.round(distancia_km * km_adicional_6_10) : Math.round(distancia_km * km_adicional_10_mas);
  if (porcentajeAjuste > 0) neto = Math.round(neto * (1 + porcentajeAjuste / 100));
  let descuentoValor = 0, descuentoTexto = "";
  if (codigo_cupon && cupones[codigo_cupon.toUpperCase()]) { const porcentaje = cupones[codigo_cupon.toUpperCase()]; descuentoValor = Math.round(neto * (porcentaje / 100)); descuentoTexto = `Descuento ${codigo_cupon.toUpperCase()} ${porcentaje}%`; }
  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento * 0.19);
  const total = netoConDescuento + iva;
  return { neto, descuentoValor, descuentoTexto, iva, total, netoConDescuento };
}

// Enviar correo
async function enviarCorreo(cliente, cotizacion) {
  if (!cliente?.correo) return;
  try {
    // Correo al cliente
    await resend.emails.send({ from:"contacto@tumotoexpress.cl", to:cliente.correo, subject:"Cotización TuMotoExpress", html:`<h2>Hola ${cliente.nombre||"cliente"}</h2><p><strong>Total:</strong> $${cotizacion.total}</p>` });
    // Copia interna
    await resend.emails.send({ from:"contacto@tumotoexpress.cl", to:"contacto@tumotoexpress.cl", subject:"Copia Cotización", html:`<p>Cliente: ${cliente.nombre||""}<br>Teléfono: ${cliente.telefono||""}<br>Correo: ${cliente.correo||""}<br>Total: $${cotizacion.total}</p>` });
  } catch (err) { console.error("Error enviando correo:", err.message); }
}

// Endpoint cotizar
app.post("/cotizar", async (req, res) => {
  try {
    const { inicio, destino, cupon, nombre, telefono, correo } = req.body;
    if (!inicio || !destino) return res.status(400).json({ error: "Faltan datos" });

    const distancia_km = await calcularDistancia(inicio, destino);
    if (!distancia_km) return res.status(400).json({ error: "No se pudo calcular distancia" });

    const resultado = calcularPrecio(distancia_km, cupon);
    const respuesta = { inicio, destino, distancia_km, ...resultado };

    res.json(respuesta);
    enviarCorreo({ nombre, telefono, correo }, respuesta);
  } catch (error) { console.error("Error en /cotizar:", error); res.status(500).json({ error: "Error interno del servidor" }); }
});

// Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));