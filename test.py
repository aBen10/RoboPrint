from flask import Flask, render_template
import os

app = Flask(__name__)

@app.route('/')
def index():
    # Print absolute path for debugging
    print(f"Current working directory: {os.getcwd()}")
    print(f"Template folder path: {os.path.join(os.getcwd(), 'templates')}")
    print(f"Template exists: {os.path.exists(os.path.join(os.getcwd(), 'templates', 'index.html'))}")
    return render_template('index.html')

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')