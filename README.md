# Radiology Board Review

## 📌 Overview
This project is a Python and Javascript application that presents Radiology cases to the user, with options for answer multiple choice questions or Oral Boards format answers to the case. For the Oral Boards answers, the user dictates a description of the case, and the text is transcribed and compared with the expected answer. There is use of an LLM to score the oral answers and provide feedback to the user, as well as to answer queries about the material covered in a case. The application has been deployed using AWS to https://e6x8kt8qvp.us-east-1.awsapprunner.com 


---
## 🚀 Setup Instructions
### 1️⃣ Clone the repository
```sh
git clone https://github.com/mille055/board_review_2.git
```

---
---

## 📂 AWS Services Used
- **AWS AppRunner** - Serverless app execution.
- **Amazon S3** - File storage for radiology teaching files.
- **DynamoDB** - Metadata storage.
- **AWS Whisper** - Future plan for the voice transcription

---

## 📜 License
This project is open-source under the **MIT License**.

---

## 👨‍💻 Author
Dr. Chad Miller - [Duke Radiology](https://radiology.duke.edu/)

