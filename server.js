const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// --- Cargar clave de servicio ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Clave de servicio cargada desde variable de entorno');
  } catch (e) {
    console.error('❌ Error al parsear FIREBASE_SERVICE_ACCOUNT:', e.message);
    process.exit(1);
  }
} else {
  try {
    const keyPath = './firebase-key.json';
    if (!fs.existsSync(keyPath)) {
      console.error('❌ No se encuentra firebase-key.json');
      process.exit(1);
    }
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log('✅ Clave de servicio cargada desde firebase-key.json');
  } catch (e) {
    console.error('❌ Error al leer firebase-key.json:', e.message);
    process.exit(1);
  }
}

// --- Inicializar Firebase Admin ---
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin inicializado correctamente');
} catch (e) {
  console.error('❌ Error al inicializar Firebase Admin:', e.message);
  process.exit(1);
}

const db = admin.firestore();

// =========================================================
// CATEGORÍAS VÁLIDAS
// =========================================================
const CATEGORIAS_VALIDAS = [
  'restaurante', 'cafeteria', 'bar', 'reposteria', 'elaborador_alimentos',
  'mercado', 'ropa_calzado', 'ferreteria', 'farmacia', 'electronica', 'papeleria',
  'peluqueria', 'salon_belleza', 'tatuajes',
  'taller_electronica', 'taller_mecanico', 'costura',
  'sala_juegos', 'billar', 'piscina', 'eventos',
  'consulta_medica', 'veterinaria',
  'taxi', 'transporte_provincial', 'alquiler_vehiculos',
  'fotografia', 'gestoria', 'tutorias', 'recargas',
  'otros',
];

// =========================================================
// USUARIOS ADMIN
// =========================================================
const ADMIN_USERNAMES = [
  'noblesse',
];

function esAdmin(username) {
  return ADMIN_USERNAMES.includes(username);
}

// =========================================================
// HELPER: Validar categorías
// =========================================================
function validarCategorias(categoriaPrincipal, categoriasSecundarias) {
  if (!categoriaPrincipal || typeof categoriaPrincipal !== 'string') {
    return { valido: false, error: 'La categoría principal es obligatoria' };
  }
  if (!CATEGORIAS_VALIDAS.includes(categoriaPrincipal)) {
    return { valido: false, error: `Categoría principal inválida: ${categoriaPrincipal}` };
  }
  const secundarias = categoriasSecundarias || [];
  if (!Array.isArray(secundarias)) {
    return { valido: false, error: 'categoriasSecundarias debe ser un array' };
  }
  if (secundarias.length > 2) {
    return { valido: false, error: 'Máximo 2 categorías secundarias' };
  }
  if (new Set(secundarias).size !== secundarias.length) {
    return { valido: false, error: 'Categorías secundarias repetidas' };
  }
  if (secundarias.includes(categoriaPrincipal)) {
    return { valido: false, error: 'La principal no puede repetirse en secundarias' };
  }
  for (const sec of secundarias) {
    if (!CATEGORIAS_VALIDAS.includes(sec)) {
      return { valido: false, error: `Categoría secundaria inválida: ${sec}` };
    }
  }
  return { valido: true };
}

// --- INIC