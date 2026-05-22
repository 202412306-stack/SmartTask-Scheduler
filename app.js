import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    setPersistence,
    browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    getFirestore,
    collection,
    addDoc,
    onSnapshot,
    query,
    where,
    doc,
    deleteDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ======================================================
// FIREBASE CONFIG
// ======================================================
const firebaseConfig = {
    apiKey: "AIzaSyBw-u4Pzc8zqj4r_Drh6kAY8BIMFcr6gJ8",
    authDomain: "smarttask-fd2f4.firebaseapp.com",
    projectId: "smarttask-fd2f4",
    storageBucket: "smarttask-fd2f4.firebasestorage.app",
    messagingSenderId: "854448533703",
    appId: "1:854448533703:web:5f11346a36e96ae4f58ee2"
};

// ======================================================
// INITIALIZE
// ======================================================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

setPersistence(auth, browserLocalPersistence)
.catch(err => console.error(err));

// ======================================================
// GLOBALS
// ======================================================
let snapshotUnsubscribe = null;
let cachedTasksArray = [];
let reminderCheckInterval = null;
let submitTaskInProgress = false;
let lastTaskCreateSignature = '';
let lastTaskCreateAt = 0;

let systemGeneratedOtp = null;
let pendingRegistrationData = null;

// ======================================================
// SAFE REDIRECT
// ======================================================
function safeRedirect(targetPage) {
    const urlObj = new URL(window.location.href);
    let path = urlObj.pathname;

    if (path.endsWith('/')) {
        urlObj.pathname = path + targetPage;
    } else {
        const lastSlashIdx = path.lastIndexOf('/');
        const lastSegment = path.substring(lastSlashIdx + 1);

        if (!lastSegment.includes('.')) {
            urlObj.pathname = path + '/' + targetPage;
        } else {
            urlObj.pathname = path.substring(0, lastSlashIdx + 1) + targetPage;
        }
    }
    window.location.replace(urlObj.toString());
}

// =====================================================
// AUTH STATE
// =====================================================
onAuthStateChanged(auth, (user) => {
    const currentPath = window.location.pathname.toLowerCase();

    if (user) {
        if (
            currentPath.includes("index.html") ||
            currentPath.includes("login.html") ||
            currentPath.endsWith("/")
        ) {
            safeRedirect("dashboard.html");
            return;
        }

        updateUserAccountUI(user);
        setupRealtimeTasks(user.email);
        initializeReminderWatcher();
    } else {
        if (currentPath.includes("dashboard.html")) {
            safeRedirect("index.html");
        }
    }
});

// ======================================================
// DOM READY
// ======================================================
document.addEventListener("DOMContentLoaded", () => {
    setupLoginInterfaceListeners();
    setupOtpInputsBehavior();

    const isDashboard = window.location.pathname.toLowerCase().includes("dashboard.html");

    if (isDashboard) {
        injectModularSystemInterfaces();
        initClockUtilities();
        setupDashboardInterfaceListeners();
        bindFeatureCardsToModals();

        if (auth.currentUser) {
            updateUserAccountUI(auth.currentUser);
        }
    }
});

// ======================================================
// ACCOUNT UI
// ======================================================
function updateUserAccountUI(user) {
    if (!user) return;

    const emailText = user.email || "Account";
    const username = user.email ? user.email.split('@')[0] : "User";

    const userEmailEl = document.getElementById("userEmail");
    const accountNameEl = document.getElementById("userAccountName");

    if (userEmailEl) {
        userEmailEl.textContent = emailText;
    }

    if (accountNameEl) {
        accountNameEl.innerHTML = `
            <i class="fa-solid fa-user-circle mr-2 text-purple-400"></i>
            ${username}
        `;
    }
}

// ======================================================
// CLOCK & GREETINGS SYNCHRONIZATION
// ======================================================
function updateDynamicGreeting(hour) {
    const greetingEl = document.getElementById('greetingMsg');
    if (!greetingEl) return;

    let greeting = 'Good evening';

    if (hour >= 5 && hour < 12) {
        greeting = 'Good morning';
    } else if (hour >= 12 && hour < 18) {
        greeting = 'Good afternoon';
    }

    if (greetingEl.textContent !== greeting) {
        greetingEl.textContent = greeting;
    }
}

function initClockUtilities() {
    const timeEl = document.getElementById('liveTime');
    const dateEl = document.getElementById('liveDate');

    function refreshClock() {
        const now = new Date();

        if (timeEl) {
            timeEl.textContent = now.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        }

        if (dateEl) {
            dateEl.textContent = now.toLocaleDateString([], {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric'
            });
        }

        updateDynamicGreeting(now.getHours());
    }

    refreshClock();
    setInterval(refreshClock, 1000);
}

document.addEventListener('DOMContentLoaded', initClockUtilities);

// ======================================================
// REMINDERS REALTIME CRON
// ======================================================
function initializeReminderWatcher() {
    if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission();
    }

    if (reminderCheckInterval) {
        clearInterval(reminderCheckInterval);
    }

    reminderCheckInterval = setInterval(async () => {
        const now = new Date();

        for (const task of cachedTasksArray) {
            if (!task.reminderDateTime) continue;
            if (task.completed) continue;
            if (task.reminderTriggered) continue;

            const reminderTime = new Date(task.reminderDateTime);
            const diff = reminderTime.getTime() - now.getTime();

            if (diff <= 60000 && diff >= 0) {
                if (Notification.permission === "granted") {
                    new Notification("⏰ Task Reminder", {
                        body: `${task.title} is scheduled now.`
                    });
                }

                alert(`Reminder:\n\n${task.title}\n\nTime has arrived.`);
                task.reminderTriggered = true;

                try {
                    await updateDoc(doc(db, "tasks", task.id), {
                        reminderTriggered: true
                    });
                } catch (err) {
                    console.error(err);
                }
            }
        }
    }, 10000);
}

// ======================================================
// MODAL ANIMATION HANDLERS (FRESH & SMOOTH)
// ======================================================
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.classList.add('opacity-100');

    const innerBox = modal.querySelector('.modal-inner');
    if (innerBox) {
        innerBox.classList.remove('scale-95');
        innerBox.classList.add('scale-100');
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('opacity-100');
    modal.classList.add('opacity-0', 'pointer-events-none');

    const innerBox = modal.querySelector('.modal-inner');
    if (innerBox) {
        innerBox.classList.remove('scale-100');
        innerBox.classList.add('scale-95');
    }
}

window.openModal = openModal;
window.closeModal = closeModal;

// ======================================================
// INJECT MODULAR COMPONENT INTERFACES
// ======================================================
let activeTaskFilter = 'All';

function injectModularSystemInterfaces() {
    if (document.getElementById('modularSystemContainer')) {
        setupModuleSubmissionListeners();
        return;
    }

    if (document.getElementById('modTasksModal')) {
        setupModuleSubmissionListeners();
        return;
    }

    const container = document.createElement('div');
    container.id = 'modularSystemContainer';

    container.innerHTML = `
        <div id="modTasksModal" class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 transition-all duration-300 opacity-0 pointer-events-none">
            <div class="modal-inner bg-[#151722] border border-[#2A2D3E] rounded-2xl w-full max-w-md p-6 transform scale-95 transition-all duration-300 shadow-2xl shadow-emerald-900/10">
                <h3 class="text-white text-xl font-bold mb-4 flex items-center gap-2">
                    <i class="fa-solid fa-list-check text-emerald-400"></i> My Tasks Manager
                </h3>
                <input type="text" id="modTaskTitle" placeholder="Enter task objective..." 
                       class="w-full mb-4 p-3 rounded-lg bg-[#1E2030] text-white border border-[#2A2D3E] focus:outline-none focus:border-emerald-500 transition-colors">
                <select id="modTaskCategory" class="w-full mb-6 p-3 rounded-lg bg-[#1E2030] text-white border border-[#2A2D3E] focus:outline-none focus:border-emerald-500 transition-colors">
                    <option value="Work">Work Category</option>
                    <option value="Personal">Personal Category</option>
                </select>
                <div class="flex justify-end gap-3">
                    <button id="closeTasksModalBtn" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">Cancel</button>
                    <button id="modSubmitTaskBtn" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors shadow-lg shadow-emerald-600/20">Create Task</button>
                </div>
            </div>
        </div>

        <div id="modCalendarModal" class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 transition-all duration-300 opacity-0 pointer-events-none">
            <div class="modal-inner bg-[#151722] border border-[#2A2D3E] rounded-2xl w-full max-w-md p-6 transform scale-95 transition-all duration-300 shadow-2xl shadow-purple-900/10">
                <h3 class="text-white text-xl font-bold mb-4 flex items-center gap-2">
                    <i class="fa-solid fa-calendar-days text-purple-400"></i> Calendar Scheduler
                </h3>
                <label class="block text-xs text-gray-400 mb-1">Select Core Target Task</label>
                <select id="modCalendarTaskSelect" class="w-full mb-4 p-3 rounded-lg bg-[#1E2030] text-white border border-[#2A2D3E] focus:outline-none focus:border-purple-500 transition-colors">
                    </select>
                <div class="flex gap-3 mb-6">
                    <div class="w-1/2">
                        <label class="block text-xs text-gray-400 mb-1">Target Date</label>
                        <input type="date" id="modCalendarDate" class="w-full p-3 rounded-lg bg-[#1E2030] text-white border border-[#2A2D3E] focus:outline-none focus:border-purple-500 transition-colors [color-scheme:dark]">
                    </div>
                    <div class="w-1/2">
                        <label class="block text-xs text-gray-400 mb-1">Trigger Time</label>
                        <input type="time" id="modCalendarTime" class="w-full p-3 rounded-lg bg-[#1E2030] text-white border border-[#2A2D3E] focus:outline-none focus:border-purple-500 transition-colors [color-scheme:dark]">
                    </div>
                </div>
                <div class="flex justify-end gap-3">
                    <button id="closeCalendarModalBtn" class="px-4 py-2 text-gray-400 hover:text-white transition-colors">Cancel</button>
                    <button id="modSubmitScheduleBtn" class="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors shadow-lg shadow-purple-600/20">Commit Schedule</button>
                </div>
            </div>
        </div>

        <div id="modRemindersModal" class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 transition-all duration-300 opacity-0 pointer-events-none">
            <div class="modal-inner bg-[#151722] border border-[#2A2D3E] rounded-2xl w-full max-w-lg p-6 transform scale-95 transition-all duration-300 shadow-2xl shadow-amber-900/10">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-white text-xl font-bold flex items-center gap-2">
                        <i class="fa-solid fa-bell text-amber-400"></i> Active Alert Reminders
                    </h3>
                    <button id="closeRemindersModalBtn" class="text-gray-400 hover:text-white transition-colors text-lg">✕</button>
                </div>
                <div id="modRemindersList" class="max-h-60 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                    </div>
            </div>
        </div>

        <div id="modInboxModal" class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 transition-all duration-300 opacity-0 pointer-events-none">
            <div class="modal-inner bg-[#151722] border border-[#2A2D3E] rounded-2xl w-full max-w-lg p-6 transform scale-95 transition-all duration-300 shadow-2xl shadow-blue-900/10">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-white text-xl font-bold flex items-center gap-2">
                        <i class="fa-solid fa-inbox text-blue-400"></i> Notification Inbox Logs
                    </h3>
                    <button id="closeInboxModalBtn" class="text-gray-400 hover:text-white transition-colors text-lg">✕</button>
                </div>
                <div id="modInboxList" class="max-h-60 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                    </div>
            </div>
        </div>
    `;

    document.body.appendChild(container);
    setupModuleSubmissionListeners();
}

// ======================================================
// Remaining code omitted for brevity in this generated file.
// Use this file only as a reference for syntax fixes.
// ======================================================

