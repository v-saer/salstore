import * as THREE from 'three';

const plans = {
  '3m': { months: 3, price: '$13.88' },
  '6m': { months: 6, price: '$17.77' },
  '12m': { months: 12, price: '$29.99' },
};
const state = { planId: '6m', profile: null, busy: false, activeOrder: null, claimSending: false };
const pendingOrderStorageKey = 'salstore.pending-aba-order';
const lookupForm = document.querySelector('#lookup-form');
const usernameInput = document.querySelector('#username');
const lookupMessage = document.querySelector('#lookup-message');
const profileResult = document.querySelector('#profile-result');
const checkoutButton = document.querySelector('#checkout-button');
const checkoutHint = document.querySelector('#checkout-hint');
const toast = document.querySelector('#toast');
const statusDialog = document.querySelector('#status-dialog');
const paymentFollowup = document.querySelector('#payment-followup');
const claimPaymentButton = document.querySelector('#claim-payment-button');

try {
  const pendingOrder = JSON.parse(sessionStorage.getItem(pendingOrderStorageKey) || 'null');
  if (pendingOrder?.orderId && pendingOrder?.username && pendingOrder?.plan) state.activeOrder = pendingOrder;
} catch {
  sessionStorage.removeItem(pendingOrderStorageKey);
}

function renderPaymentFollowup() {
  paymentFollowup.hidden = !state.activeOrder;
  if (!state.activeOrder) return;
  const sent = state.activeOrder.paymentClaimSent;
  document.querySelector('#payment-followup-copy').textContent = sent
    ? 'SalStore has been alerted. Payment is awaiting manual ABA verification.'
    : state.claimSending
      ? 'Sending your payment claim to SalStore…'
      : 'Finished paying in ABA? Tell SalStore to check the payment.';
  claimPaymentButton.disabled = sent || state.claimSending;
  claimPaymentButton.textContent = sent ? 'Alert sent' : state.claimSending ? 'Sending…' : 'I’ve paid';
}

function updateCheckout() {
  const ready = Boolean(state.profile && !state.busy);
  checkoutButton.disabled = !ready;
  checkoutHint.textContent = state.busy
    ? 'Opening secure ABA Pay link…'
    : state.profile
      ? `Ready for @${state.profile.username}. ABA Pay link for ${plans[state.planId].price}.`
      : 'Choose a plan and look up your username to continue.';
  document.querySelector('#order-username').textContent = state.profile
    ? `@${state.profile.username}`
    : 'Look up your Telegram username';
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 3500);
}

function showDialog({ title, body, details = '', eyebrow = 'ORDER UPDATE', symbol = '✳' }) {
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-body').textContent = body;
  document.querySelector('#dialog-details').textContent = details;
  document.querySelector('#dialog-eyebrow').textContent = eyebrow;
  document.querySelector('#dialog-symbol').textContent = symbol;
  if (!statusDialog.open) statusDialog.showModal();
}

function renderProfile(profile) {
  profileResult.replaceChildren();
  const avatar = document.createElement('span');
  avatar.className = 'profile-avatar';
  avatar.textContent = (profile.displayName || profile.username || '?').trim().slice(0, 1).toUpperCase();
  const photoUrl = profile.photoUrl;
  const safePhotoUrl = typeof photoUrl === 'string' && (
    /^https:\/\//i.test(photoUrl) || /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(photoUrl)
  );
  if (safePhotoUrl) {
    const photo = document.createElement('img');
    photo.className = 'profile-photo';
    photo.src = photoUrl;
    photo.alt = `Profile photo for @${profile.username}`;
    photo.addEventListener('load', () => avatar.classList.add('has-photo'), { once: true });
    photo.addEventListener('error', () => photo.remove(), { once: true });
    avatar.append(photo);
  }
  const copy = document.createElement('span');
  copy.className = 'profile-copy';
  const name = document.createElement('strong');
  name.textContent = profile.displayName || `@${profile.username}`;
  const handle = document.createElement('span');
  handle.textContent = `@${profile.username}`;
  copy.append(name, handle);
  const flag = document.createElement('span');
  flag.className = `premium-flag${profile.premium ? ' is-premium' : ''}`;
  flag.textContent = profile.premium ? 'PREMIUM' : 'NOT PREMIUM';
  profileResult.append(avatar, copy, flag);
  profileResult.hidden = false;
}

for (const button of document.querySelectorAll('.plan-row')) {
  button.addEventListener('click', () => {
    state.planId = button.dataset.plan;
    for (const row of document.querySelectorAll('.plan-row')) {
      const selected = row === button;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-checked', String(selected));
    }
    updateCheckout();
  });
}

lookupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim().replace(/^@+/, '');
  state.profile = null;
  profileResult.hidden = true;
  updateCheckout();
  lookupMessage.className = 'lookup-message loading';
  lookupMessage.textContent = 'Checking public profile…';
  const submitButton = lookupForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch(`/api/telegram/profile?username=${encodeURIComponent(username)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not look up that username.');
    state.profile = result.profile;
    renderProfile(result.profile);
    lookupMessage.className = 'lookup-message success';
    lookupMessage.textContent = result.profile.premium
      ? 'Profile found. This account already has Premium.'
      : 'Profile found. This account is not currently Premium.';
  } catch (error) {
    lookupMessage.className = 'lookup-message error';
    lookupMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    updateCheckout();
  }
});

checkoutButton.addEventListener('click', async () => {
  if (!state.profile || !plans[state.planId]) return;
  const paymentWindow = window.open('about:blank', '_blank');
  if (!paymentWindow) {
    showToast('Allow pop-ups to open the secure ABA Pay link.');
    return;
  }
  paymentWindow.opener = null;
  state.busy = true;
  updateCheckout();
  try {
    const response = await fetch('/api/aba/payment-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: state.planId, username: state.profile.username }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Checkout could not be started.');
    if (!result.paymentUrl || new URL(result.paymentUrl).hostname !== 'pay.ababank.com') {
      throw new Error('ABA Pay did not return a valid payment link.');
    }
    window.alert(`Payment link: ${result.paymentUrl}`);
    paymentWindow.location.replace(result.paymentUrl);
    state.activeOrder = {
      orderId: result.orderId,
      username: result.username,
      plan: result.plan,
      amount: result.amount,
      paymentClaimSent: false,
    };
    sessionStorage.setItem(pendingOrderStorageKey, JSON.stringify(state.activeOrder));
    renderPaymentFollowup();
    state.busy = false;
    updateCheckout();
    showDialog({
      title: 'ABA Pay opened.',
      body: 'Complete payment in the ABA Pay page. Then use “I’ve paid” in the checkout panel to alert SalStore. Your payment will still need to be checked in ABA.',
      details: [`ACCOUNT  @${result.username}`, `PLAN     ${result.plan}`, `AMOUNT   $${result.amount}`, `ORDER    ${result.orderId}`, 'STATUS   AWAITING CONFIRMATION'].join('\n'),
      eyebrow: 'PAYMENT LINK · NOT YET CONFIRMED',
      symbol: '↗',
    });
  } catch (error) {
    paymentWindow.close();
    showToast(error.message);
    state.busy = false;
    updateCheckout();
  }
});

claimPaymentButton.addEventListener('click', async () => {
  if (!state.activeOrder || state.claimSending || state.activeOrder.paymentClaimSent) return;
  state.claimSending = true;
  renderPaymentFollowup();
  try {
    const response = await fetch('/api/aba/payment-claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: state.activeOrder.orderId }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not send the payment alert.');
    state.activeOrder.paymentClaimSent = result.notified;
    sessionStorage.setItem(pendingOrderStorageKey, JSON.stringify(state.activeOrder));
  } catch (error) {
    showToast(error.message);
  } finally {
    state.claimSending = false;
    renderPaymentFollowup();
  }
});

document.querySelector('#dialog-close').addEventListener('click', () => statusDialog.close());
document.querySelector('#dialog-action').addEventListener('click', () => {
  statusDialog.close();
  window.history.replaceState({}, '', '/');
});

async function checkReturnFromCheckout() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'cancelled') {
    showDialog({
      title: 'Payment not confirmed.',
      body: 'The ABA payment link returned to SalStore without a verifiable payment status. Check the ABA app before trying the link again.',
      eyebrow: 'PAYMENT STATUS UNKNOWN',
      symbol: '↩',
    });
  }
}

checkReturnFromCheckout();
updateCheckout();
renderPaymentFollowup();

function createPremiumBadge() {
  const canvas = document.querySelector('#premium-canvas');
  const stage = canvas.parentElement;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 8.2);
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
  keyLight.position.set(-3, 4, 5);
  scene.add(keyLight);
  const fillLight = new THREE.PointLight(0xffd36a, 20, 9);
  fillLight.position.set(2, 1, 4);
  scene.add(fillLight);

  const badge = new THREE.Group();
  scene.add(badge);
  const blue = new THREE.MeshStandardMaterial({ color: 0x2599e8, roughness: .28, metalness: .16 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xd8f3ff, roughness: .22, metalness: .62 });
  const planeMaterial = new THREE.MeshStandardMaterial({ color: 0xf5fcff, roughness: .24, metalness: .08, side: THREE.DoubleSide });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffcb52, roughness: .3, metalness: .35 });

  const disk = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.48, .32, 80, 1), blue);
  disk.rotation.x = Math.PI / 2;
  badge.add(disk);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.43, .055, 12, 80), rimMaterial);
  rim.position.z = .2;
  badge.add(rim);

  const plane = new THREE.Shape();
  plane.moveTo(-.83, .28);
  plane.lineTo(.92, .78);
  plane.lineTo(.22, -.78);
  plane.lineTo(.04, -.16);
  plane.lineTo(-.48, -.02);
  plane.lineTo(-.17, .14);
  plane.closePath();
  const planeMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(plane, { depth: .08, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: .035, bevelThickness: .035, curveSegments: 8 }), planeMaterial);
  planeMesh.position.z = .19;
  badge.add(planeMesh);

  const starShape = new THREE.Shape();
  for (let point = 0; point < 10; point += 1) {
    const angle = Math.PI / 2 + point * Math.PI / 5;
    const radius = point % 2 === 0 ? .47 : .21;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (point === 0) starShape.moveTo(x, y);
    else starShape.lineTo(x, y);
  }
  starShape.closePath();
  const star = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape, { depth: .11, bevelEnabled: true, bevelSegments: 3, bevelSize: .035, bevelThickness: .04 }), gold);
  star.position.set(1.12, 1.13, .42);
  star.rotation.z = .16;
  badge.add(star);

  const halo = new THREE.Mesh(new THREE.TorusGeometry(2.05, .012, 5, 120), new THREE.MeshBasicMaterial({ color: 0x4cb8f5, transparent: true, opacity: .55 }));
  halo.rotation.set(.32, .18, -.2);
  badge.add(halo);
  const orbit = new THREE.Group();
  badge.add(orbit);
  for (const [x, y, size, color] of [[-1.8, .85, .09, 0xffcb52], [1.85, -.58, .065, 0xffffff], [-1.45, -1.16, .055, 0x2599e8]]) {
    const mote = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .18, roughness: .28 }));
    mote.position.set(x, y, .1);
    orbit.add(mote);
  }
  badge.rotation.set(-.12, -.24, -.08);

  const resize = () => {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width < 500 ? 9.3 : 8.2;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  resize();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pointer = { x: 0, y: 0 };
  stage.addEventListener('pointermove', (event) => {
    const rect = stage.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width - .5) * 2;
    pointer.y = ((event.clientY - rect.top) / rect.height - .5) * 2;
  });
  const clock = new THREE.Clock();
  const animate = () => {
    if (!reducedMotion) requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    badge.position.y = reducedMotion ? 0 : Math.sin(time * .8) * .12;
    badge.rotation.y = -.24 + pointer.x * .1 + (reducedMotion ? 0 : Math.sin(time * .38) * .1);
    badge.rotation.x = -.12 + pointer.y * .06;
    if (!reducedMotion) {
      star.rotation.y = Math.sin(time * 1.4) * .22;
      star.rotation.z = .16 + Math.sin(time * 1.1) * .08;
      orbit.rotation.z = time * .16;
    }
    renderer.render(scene, camera);
  };
  animate();
}

try {
  createPremiumBadge();
} catch (error) {
  console.error('3D scene could not start:', error);
  document.querySelector('.premium-stage').classList.add('scene-unavailable');
}
