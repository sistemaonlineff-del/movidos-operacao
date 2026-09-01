import os
from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")}})

@app.get('/api/health')
def health():
    return jsonify(service='movidos-api', status='ok')

if __name__ == '__main__':
    app.run(host=os.getenv('APP_HOST', '127.0.0.1'), port=int(os.getenv('APP_PORT', '5000')), debug=os.getenv('FLASK_DEBUG', 'false').lower() == 'true')
