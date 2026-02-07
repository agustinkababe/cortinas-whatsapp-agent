const OpenAI = require("openai");

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.responses.create({
    model: "gpt-5",
    reasoning: { effort: "low" },
    input: "Respondé solo con: OK"
  });
  console.log(r.output_text);
}

main().catch(e => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
