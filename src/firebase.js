// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD4WMsOWxXFDLExbLk39Fa0kD5v0TY3cfs",
  authDomain: "file-hosting-01.firebaseapp.com",
  databaseURL: "https://file-hosting-01-default-rtdb.firebaseio.com",
  projectId: "file-hosting-01",
  storageBucket: "file-hosting-01.appspot.com",
  messagingSenderId: "813915068434",
  appId: "1:813915068434:web:65d63898f448318bc260cb",
  measurementId: "G-8SHG3H71K3"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;

export { app, analytics };
