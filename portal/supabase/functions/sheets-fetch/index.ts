const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const fail = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const { url } = await req.json();
    if (!url) return fail('Missing url');

    // Extract spreadsheet ID
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return fail('Not a valid Google Sheets URL. Copy it from your browser address bar.');

    const sheetId = idMatch[1];

    // Extract sheet tab ID (gid) if present
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    const res = await fetch(csvUrl, {
      headers: { 'User-Agent': 'AiFinanceo/1.0' },
      redirect: 'follow',
    });

    if (res.status === 401 || res.status === 403) {
      return fail(
        'Sheet is private. Open the sheet → Share → "Anyone with the link" → Viewer, then try again.'
      );
    }
    if (!res.ok) {
      return fail(`Google Sheets returned ${res.status}. Check the URL and sharing settings.`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('csv') && !contentType.includes('octet')) {
      return fail('Unexpected response from Google. Make sure the link is a Google Sheets URL.');
    }

    const csv = await res.text();
    if (!csv.trim()) return fail('The sheet appears to be empty.');

    return new Response(JSON.stringify({ csv }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
