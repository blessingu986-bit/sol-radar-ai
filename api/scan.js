
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Only POST requests are allowed."
    });
  }

  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "HELIUS_API_KEY is missing from Vercel."
    });
  }

  const { address, limit = 100 } = req.body || {};

  if (
    typeof address !== "string" ||
    !ADDRESS_RE.test(address.trim())
  ) {
    return res.status(400).json({
      error: "Please enter a valid Solana public address."
    });
  }

  const safeLimit = Math.min(
    100,
    Math.max(1, Number.parseInt(limit, 10) || 100)
  );

  try {
    const url = new URL(
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(address.trim())}/transactions`
    );

    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("limit", String(safeLimit));
    url.searchParams.set("sort-order", "desc");
    url.searchParams.set("token-accounts", "balanceChanged");

    const response = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(
        response.status === 429 ? 429 : 502
      ).json({
        error:
          response.status === 429
            ? "Helius rate limit reached. Please wait and try again."
            : `Helius returned an error (${response.status}). Check your API key and account.`
      });
    }

    if (!Array.isArray(data)) {
      return res.status(502).json({
        error: "Unexpected response from Helius."
      });
    }

    return res.status(200).json({
      address: address.trim(),
      count: data.length,
      transactions: data
    });

  } catch (error) {
    return res.status(500).json({
      error: "Unable to connect to Helius."
    });
  }
};
