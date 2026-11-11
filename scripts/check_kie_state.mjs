// فحص مباشر لحالة المهمة لدى kie.ai — للتشخيص فقط
const id = process.argv[2];
const res = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${id}`, {
  headers: { Authorization: "Bearer " + process.env.KIE_KEY },
});
const j = await res.json();
console.log(JSON.stringify(j.data, null, 2).slice(0, 600));
