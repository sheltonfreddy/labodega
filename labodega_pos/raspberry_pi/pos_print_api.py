from fastapi import FastAPI, Request
import subprocess, tempfile

app = FastAPI()

@app.post("/print_raw")
async def print_raw(request: Request):
    data = await request.body()
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(data)
        path = f.name
    subprocess.run(["lp", "-d", "epson_pos", path], check=False)
    return {"status": "printed"}