// frontend/js/auth.js

export function initAuth() {
    // Skip auth check on login page itself
    if (window.location.pathname.includes('login.html')) {
        return;
    }
    const token = localStorage.getItem('jwt');
  
  // If no token, redirect to login page
  if (!token) {
    window.location.href = '/login.html';
    return;
  }
  
  // Optional: Validate token with backend
  validateToken(token);
}

async function validateToken(token) {
  try {
    const res = await fetch('/api/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Invalid token');
  } catch {
    localStorage.removeItem('jwt');
    window.location.href = '/login.html';
  }
}

export function logout() {
  localStorage.removeItem('jwt');
  window.location.href = '/login.html';
}

export function getAuthHeaders() {
  const token = localStorage.getItem('jwt');
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}