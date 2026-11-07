// PayPal JavaScript SDK v6: load the core script once, create one SDK
// instance, and start a one-time payment session per milestone.
// The server creates every order with intent AUTHORIZE, so approving in the
// PayPal window puts the money on hold instead of charging it.

let sdkPromise = null;

function loadSdk({ sdkUrl, clientId }) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdkUrl;
    script.async = true;
    script.onload = async () => {
      try {
        const sdk = await window.paypal.createInstance({
          clientId,
          components: ['paypal-payments'],
          pageType: 'checkout',
        });
        resolve(sdk);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('The PayPal SDK could not be loaded.'));
    document.head.append(script);
  });
  sdkPromise.catch(() => { sdkPromise = null; });
  return sdkPromise;
}

/**
 * Renders a PayPal button into `container`.
 * createOrder(flow) must resolve to { orderId, approveUrl } from our server.
 * If the SDK is unavailable, falls back to a full-page redirect to PayPal.
 */
export async function mountPayPalButton(container, { paypalConfig, currency, createOrder, onApproved, onCancel, onError }) {
  container.innerHTML = '<p class="fund-loading">Loading PayPal…</p>';
  try {
    const sdk = await loadSdk(paypalConfig);
    const methods = await sdk.findEligibleMethods({ currencyCode: currency });
    if (!methods.isEligible('paypal')) throw new Error(`PayPal is not available for ${currency} here.`);

    container.innerHTML = '<paypal-button type="pay" class="paypal-button"></paypal-button>';
    const button = container.querySelector('paypal-button');
    const session = sdk.createPayPalOneTimePaymentSession({
      onApprove: async ({ orderId }) => onApproved(orderId),
      onCancel: () => onCancel?.(),
      onError: (error) => onError?.(error),
    });
    button.addEventListener('click', async () => {
      try {
        // v6 expects a promise that resolves to { orderId }.
        await session.start({ presentationMode: 'auto' }, createOrder('sdk').then(({ orderId }) => ({ orderId })));
      } catch (error) {
        onError?.(error);
      }
    });
  } catch (error) {
    console.warn('[paypal] SDK unavailable, using redirect checkout:', error);
    container.innerHTML = `
      <button type="button" class="button button-paypal" data-fallback>Continue to PayPal</button>
      <p class="fund-note">The PayPal window could not open here, so you will continue on PayPal’s site and come back automatically.</p>`;
    const fallback = container.querySelector('[data-fallback]');
    fallback.addEventListener('click', async () => {
      fallback.disabled = true;
      try {
        const { approveUrl } = await createOrder('redirect');
        if (!approveUrl) throw new Error('PayPal did not return a checkout link.');
        window.location.assign(approveUrl);
      } catch (err) {
        fallback.disabled = false;
        onError?.(err);
      }
    });
  }
}
