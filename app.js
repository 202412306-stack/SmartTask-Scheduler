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
// ======================================================
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

    let greeting = 'Good evening'; // Default for 18 (6 PM) to 4 AM
    
    if (hour >= 5 && hour < 12) {
        greeting = 'Good morning';
    } else if (hour >= 12 && hour < 18) {
        greeting = 'Good afternoon';
    }

    // Optimization: Only update the DOM if the greeting actually changes
    // This stops the browser from re-rendering this element every second
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
        
        // Sync greeting perfectly with the active clock
        updateDynamicGreeting(now.getHours());
    }

    // Run once immediately, then every 1000ms (1 second)
    refreshClock();
    setInterval(refreshClock, 1000);
}

// Make sure the DOM is fully loaded before running the script
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
    
    // Remove hidden/pointer locks, add opacity
    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.classList.add('opacity-100');
    
    // Scale up the inner content box
    const innerBox = modal.querySelector('.modal-inner');
    if (innerBox) {
        innerBox.classList.remove('scale-95');
        innerBox.classList.add('scale-100');
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    
    // Fade out
    modal.classList.remove('opacity-100');
    modal.classList.add('opacity-0', 'pointer-events-none');
    
    // Scale down the inner content box
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
    // Note: Replaced 'hidden' with smooth transition classes
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

function resetTaskModalState() {
    const idInput = document.getElementById('modTaskId');
    const titleInput = document.getElementById('modTaskTitle');
    const categoryInput = document.getElementById('modTaskCategory');
    const submitBtn = document.getElementById('modSubmitTaskBtn');
    const modalTitle = document.getElementById('modTasksModalTitle');

    if (idInput) idInput.value = '';
    if (titleInput) titleInput.value = '';
    if (categoryInput) categoryInput.value = 'Work';
    if (submitBtn) submitBtn.textContent = 'Create Task';
    if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-list-check text-emerald-400"></i> Create Task';
}

function openTaskModalForEdit(task) {
    if (!task) return;

    const idInput = document.getElementById('modTaskId');
    const titleInput = document.getElementById('modTaskTitle');
    const categoryInput = document.getElementById('modTaskCategory');
    const submitBtn = document.getElementById('modSubmitTaskBtn');
    const modalTitle = document.getElementById('modTasksModalTitle');

    if (idInput) idInput.value = task.id;
    if (titleInput) titleInput.value = task.title || '';
    if (categoryInput) categoryInput.value = task.category || 'Work';
    if (submitBtn) submitBtn.textContent = 'Save Changes';
    if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-list-check text-emerald-400"></i> Edit Task';

    openModal('modTasksModal');
}

// ======================================================
// INTERFACE MODULE LOGIC SUBMISSIONS & BUTTON BINDINGS
// ======================================================
function setupModuleSubmissionListeners() {
    
    // --- Cancel / Close Buttons Bindings ---
    const closeTasksModalBtn = document.getElementById('closeTasksModalBtn');
    if (closeTasksModalBtn) closeTasksModalBtn.onclick = () => closeModal('modTasksModal');

    const closeCalendarModalBtn = document.getElementById('closeCalendarModalBtn');
    if (closeCalendarModalBtn) closeCalendarModalBtn.onclick = () => closeModal('modCalendarModal');

    const closeRemindersModalBtn = document.getElementById('closeRemindersModalBtn');
    if (closeRemindersModalBtn) closeRemindersModalBtn.onclick = () => closeModal('modRemindersModal');
    const closeRemindersBtn = document.getElementById('closeRemindersBtn');
    if (closeRemindersBtn) closeRemindersBtn.onclick = () => closeModal('modRemindersModal');

    const closeInboxModalBtn = document.getElementById('closeInboxModalBtn');
    if (closeInboxModalBtn) closeInboxModalBtn.onclick = () => closeModal('modInboxModal');
    const closeInboxBtn = document.getElementById('closeInboxBtn');
    if (closeInboxBtn) closeInboxBtn.onclick = () => closeModal('modInboxModal');

    // --- Submit Basic Task (My Tasks) ---
    let modSubmitTaskBtn = document.getElementById('modSubmitTaskBtn');
    if (modSubmitTaskBtn) {
        const cleanSubmitTaskBtn = modSubmitTaskBtn.cloneNode(true);
        modSubmitTaskBtn.parentNode.replaceChild(cleanSubmitTaskBtn, modSubmitTaskBtn);
        modSubmitTaskBtn = cleanSubmitTaskBtn;
        modSubmitTaskBtn.type = 'button';

        const handleTaskSubmit = async (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();

            if (submitTaskInProgress) return;
            submitTaskInProgress = true;
            modSubmitTaskBtn.disabled = true;

            const taskId = document.getElementById('modTaskId').value;
            const title = document.getElementById('modTaskTitle').value.trim();
            const category = document.getElementById('modTaskCategory').value;
            const signature = `${taskId}|${title}|${category}`;
            const now = Date.now();

            if (!title) {
                alert("Task objective cannot be blank.");
                submitTaskInProgress = false;
                modSubmitTaskBtn.disabled = false;
                return;
            }

            if (!taskId && signature === lastTaskCreateSignature && now - lastTaskCreateAt < 2000) {
                submitTaskInProgress = false;
                modSubmitTaskBtn.disabled = false;
                return;
            }

            lastTaskCreateSignature = signature;
            lastTaskCreateAt = now;

            try {
                if (taskId) {
                    await updateDoc(doc(db, "tasks", taskId), {
                        title: title,
                        category: category
                    });

                    const existingTask = cachedTasksArray.find(item => item.id === taskId);
                    if (existingTask) {
                        existingTask.title = title;
                        existingTask.category = category;
                    }
                } else {
                    await addDoc(collection(db, "tasks"), {
                        userEmail: auth.currentUser.email,
                        title: title,
                        category: category,
                        date: null,
                        time: null,
                        reminderDateTime: null,
                        reminderTriggered: false,
                        completed: false,
                        createdAt: new Date()
                    });
                }

                resetTaskModalState();
                closeModal('modTasksModal');
            } catch (err) {
                alert(err.message);
            } finally {
                submitTaskInProgress = false;
                modSubmitTaskBtn.disabled = false;
            }
        };

        modSubmitTaskBtn.addEventListener('click', handleTaskSubmit);
    }

    // --- Update Task with Schedule (Calendar) ---
    const modSubmitScheduleBtn = document.getElementById('modSubmitScheduleBtn');
    if (modSubmitScheduleBtn) {
        modSubmitScheduleBtn.onclick = async () => {
            const taskId = document.getElementById('modCalendarTaskSelect').value;
            const date = document.getElementById('modCalendarDate').value;
            const time = document.getElementById('modCalendarTime').value;

            if (!taskId || !date || !time) {
                alert("Please select a task and set both date and time.");
                return;
            }

            const combinedDateTime = `${date}T${time}:00`;

            try {
                await updateDoc(doc(db, "tasks", taskId), {
                    date: date,
                    time: new Date(combinedDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    reminderDateTime: combinedDateTime,
                    reminderTriggered: false
                });

                closeModal('modCalendarModal');
            } catch (err) {
                alert(err.message);
            }
        };
    }
}

async function applyCalendarScheduleIfReady() {
    const taskSelect = document.getElementById('modCalendarTaskSelect');
    const dateInput = document.getElementById('modCalendarDate');
    const timeInput = document.getElementById('modCalendarTime');

    const taskId = taskSelect?.value;
    const date = dateInput?.value;
    const time = timeInput?.value;

    if (!taskId || !date || !time) {
        return false;
    }

    const combinedDateTime = `${date}T${time}:00`;

    try {
        await updateDoc(doc(db, "tasks", taskId), {
            date: date,
            time: new Date(combinedDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            reminderDateTime: combinedDateTime,
            reminderTriggered: false
        });

        closeModal('modCalendarModal');
        return true;
    } catch (err) {
        alert(err.message);
        return false;
    }
}

let calendarAutoCloseState = {
    dateTouched: false,
    timeTouched: false,
    taskTouched: false
};

function resetCalendarAutoCloseState() {
    calendarAutoCloseState.dateTouched = false;
    calendarAutoCloseState.timeTouched = false;
    calendarAutoCloseState.taskTouched = false;
}

function bindCalendarAutoCloseInputs() {
    const dateInput = document.getElementById('modCalendarDate');
    const timeInput = document.getElementById('modCalendarTime');
    const taskSelect = document.getElementById('modCalendarTaskSelect');

    const maybeAutoClose = async (source) => {
        if (!dateInput || !timeInput || !taskSelect) return;
        if (!dateInput.value || !timeInput.value || !taskSelect.value) return;

        if (source === 'date') {
            calendarAutoCloseState.dateTouched = true;
            if (!calendarAutoCloseState.timeTouched) return;
        }

        if (source === 'time') {
            calendarAutoCloseState.timeTouched = true;
        }

        if (source === 'task') {
            calendarAutoCloseState.taskTouched = true;
            if (!calendarAutoCloseState.timeTouched) return;
        }

        await applyCalendarScheduleIfReady();
    };

    if (dateInput) {
        dateInput.addEventListener('change', () => maybeAutoClose('date'));
    }
    if (timeInput) {
        timeInput.addEventListener('change', () => maybeAutoClose('time'));
    }
    if (taskSelect) {
        taskSelect.addEventListener('change', () => maybeAutoClose('task'));
    }
}

// =====================================================
// BIND FEATURE CARDS DIRECTLY TO INDEPENDENT MODALS
// ======================================================
function bindFeatureCardsToModals() {
    // Scans UI logically by text to bind the module cards smoothly
    document.querySelectorAll('div, button, section').forEach(element => {
        if (!element.children || element.children.length === 0) return;
        
        const contentText = element.innerText || "";
        
        if (contentText.includes("My Tasks") && element.classList.contains("border")) {
            element.style.cursor = "pointer";
            element.classList.add("hover:border-emerald-500/50", "transition-colors");
            element.onclick = () => openModal('modTasksModal');
        }
        else if (contentText.includes("Calendar") && element.classList.contains("border")) {
            element.style.cursor = "pointer";
            element.classList.add("hover:border-purple-500/50", "transition-colors");
            element.onclick = () => {
                populateCalendarDropdown();
                resetCalendarAutoCloseState();
                const now = new Date();
                document.getElementById('modCalendarDate').value = now.toISOString().split('T')[0];
                document.getElementById('modCalendarTime').value = "12:00";
                openModal('modCalendarModal');
            };
        }
        else if (contentText.includes("Reminders") && element.classList.contains("border")) {
            element.style.cursor = "pointer";
            element.classList.add("hover:border-amber-500/50", "transition-colors");
            element.onclick = () => {
                populateActiveRemindersPanel();
                openModal('modRemindersModal');
            };
        }
        else if (contentText.includes("Inbox") && element.classList.contains("border")) {
            element.style.cursor = "pointer";
            element.classList.add("hover:border-blue-500/50", "transition-colors");
            element.onclick = () => {
                populateInboxLogsPanel();
                openModal('modInboxModal');
            };
        }
    });
}

// ======================================================
// DYNAMIC COMPONENT POPULATORS
// ======================================================
function populateCalendarDropdown() {
    const select = document.getElementById('modCalendarTaskSelect');
    if (!select) return;
    select.innerHTML = '';

    const unscheduledTasks = cachedTasksArray.filter(t => !t.completed);
    
    if (unscheduledTasks.length === 0) {
        select.innerHTML = '<option value="">No active tasks available</option>';
        return;
    }

    unscheduledTasks.forEach(task => {
        const option = document.createElement('option');
        option.value = task.id;
        option.textContent = `${task.title} (${task.category})`;
        select.appendChild(option);
    });
}

function populateActiveRemindersPanel() {
    const container = document.getElementById('modRemindersList');
    if (!container) return;
    container.innerHTML = '';

    const scheduled = cachedTasksArray.filter(t => t.reminderDateTime && !t.reminderTriggered && !t.completed);

    if (scheduled.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500 py-4 text-center">No active upcoming alert traces found.</p>';
        return;
    }

    scheduled.forEach(t => {
        const div = document.createElement('div');
        div.className = "bg-[#1E2030] p-3 rounded-xl border border-[#2A2D3E] flex justify-between items-center transition-all hover:border-amber-500/30";
        div.innerHTML = `
            <div>
                <p class="text-white text-sm font-medium">${t.title}</p>
                <p class="text-xs text-amber-400 mt-0.5"><i class="fa-solid fa-clock mr-1"></i> Trigger: ${t.date} @ ${t.time}</p>
            </div>
            <span class="text-xs bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded border border-amber-500/20">${t.category}</span>
        `;
        container.appendChild(div);
    });
}

function populateInboxLogsPanel() {
    const container = document.getElementById('modInboxList');
    if (!container) return;
    container.innerHTML = '';

    const firedLogs = cachedTasksArray.filter(t => t.reminderTriggered);

    if (firedLogs.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500 py-4 text-center">Your notification tracking feed is empty.</p>';
        return;
    }

    firedLogs.forEach(t => {
        const div = document.createElement('div');
        div.className = "bg-[#1E2030]/60 p-3 rounded-xl border border-blue-500/10 flex justify-between items-center opacity-80 transition-all hover:opacity-100";
        div.innerHTML = `
            <div>
                <p class="text-gray-300 text-sm line-through">${t.title}</p>
                <p class="text-xs text-blue-400 mt-0.5"><i class="fa-solid fa-circle-check mr-1"></i> Fired Notification Log Checked</p>
            </div>
            <span class="text-xs text-gray-400">${t.time || "Done"}</span>
        `;
        container.appendChild(div);
    });
}

// ======================================================
// DASHBOARD GENERAL ACTIONS LISTENERS
function setActiveTaskFilter(filter) {
    activeTaskFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        if (btn.id === `filter${filter}` || (filter === 'All' && btn.id === 'filterAll')) {
            btn.classList.remove('text-gray-400', 'bg-[#0F1015]');
            btn.classList.add('text-white', 'bg-[#252836]');
        } else {
            btn.classList.remove('text-white', 'bg-[#252836]');
            btn.classList.add('text-gray-400');
        }
    });
    renderTaskList(cachedTasksArray);
}

function taskMatchesFilter(task) {
    return activeTaskFilter === 'All' || task.category === activeTaskFilter;
}

function updateTaskStats(tasks) {
    const total = tasks.length;
    const completed = tasks.filter(task => task.completed).length;
    const pending = total - completed;

    const totalEl = document.getElementById('totalTasksCount');
    const completedEl = document.getElementById('completedTasksCount');
    const pendingEl = document.getElementById('pendingTasksCount');
    const badgeEl = document.getElementById('sideBadgeTasks');

    if (totalEl) totalEl.textContent = total;
    if (completedEl) completedEl.textContent = completed;
    if (pendingEl) pendingEl.textContent = pending;
    if (badgeEl) badgeEl.textContent = total;
}

function refreshTaskDisplay() {
    updateTaskStats(cachedTasksArray);
    renderTaskList(cachedTasksArray);
}

function renderTaskList(tasks) {
    const taskList = document.getElementById('taskList');
    if (!taskList) return;

    taskList.innerHTML = '';
    const filteredTasks = tasks.filter(taskMatchesFilter);

    filteredTasks.forEach(task => {
        const row = document.createElement('div');
        row.className = "bg-[#1E2030] p-4 rounded-xl mb-2 flex justify-between items-center border border-[#2A2D3E]/40 hover:border-purple-500/30 transition-all group";
        row.innerHTML = `
            <div class="flex items-center gap-3">
                <input type="checkbox" data-id="${task.id}" ${task.completed ? "checked" : ""} class="task-toggle-checkbox accent-purple-500 h-4 w-4 rounded cursor-pointer transition-transform hover:scale-110">
                <div>
                    <p class="${task.completed ? 'line-through text-gray-500' : 'text-white font-medium transition-colors group-hover:text-purple-100'}">
                        ${task.title}
                    </p>
                    <p class="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5">
                        <span class="text-purple-400 font-medium">${task.category}</span>
                        •
                        <span class="${task.date ? 'text-gray-300' : 'text-gray-500 italic'}">
                            <i class="fa-regular fa-calendar-check text-[10px]"></i> ${task.date ? `${task.date} at ${task.time}` : "Unscheduled Plan"}
                        </span>
                    </p>
                </div>
            </div>
            <div class="flex items-center gap-2">
                <button data-id="${task.id}" class="edit-task-btn text-xs font-semibold bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white px-3 py-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 focus:opacity-100">Edit</button>
                <button data-id="${task.id}" class="delete-task-btn text-xs font-semibold bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white px-3 py-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 focus:opacity-100">Remove</button>
            </div>
        `;
        taskList.appendChild(row);
    });

    attachDynamicItemListeners();
}

// ======================================================
function setupDashboardInterfaceListeners() {
    const addTaskBtn = document.getElementById('addTaskBtn');
    const logoutBtn = document.getElementById('logoutBtn');

    if (logoutBtn) {
        logoutBtn.onclick = async () => {
            try {
                await signOut(auth);
                safeRedirect("index.html");
            } catch (err) {
                console.error(err);
            }
        };
    }

    if (addTaskBtn) {
        addTaskBtn.onclick = (e) => {
            e.preventDefault();
            if (!auth.currentUser) {
                alert("Login required.");
                return;
            }
            resetTaskModalState();
            openModal('modTasksModal');
        };
    }

    const filterButtons = [
        { id: 'filterAll', name: 'All' },
        { id: 'filterWork', name: 'Work' },
        { id: 'filterPersonal', name: 'Personal' },
        { id: 'filterSchool', name: 'School' }
    ];

    filterButtons.forEach(filter => {
        const btn = document.getElementById(filter.id);
        if (!btn) return;
        btn.type = 'button';
        btn.onclick = () => setActiveTaskFilter(filter.name);
    });

    setActiveTaskFilter(activeTaskFilter);
    bindCalendarAutoCloseInputs();
}

// ======================================================
function setupRealtimeTasks(userEmail) {
    if (snapshotUnsubscribe) {
        snapshotUnsubscribe();
    }

    const taskList = document.getElementById('taskList');
    if (!taskList) return;

    const q = query(
        collection(db, "tasks"),
        where("userEmail", "==", userEmail)
    );

    snapshotUnsubscribe = onSnapshot(q, (snapshot) => {
        const uniqueTasks = new Map();

        snapshot.forEach((docSnapshot) => {
            const task = docSnapshot.data();
            const id = docSnapshot.id;
            uniqueTasks.set(id, { id, ...task });
        });

        cachedTasksArray = Array.from(uniqueTasks.values());

        updateTaskStats(cachedTasksArray);
        renderTaskList(cachedTasksArray);

        const calendarModal = document.getElementById('modCalendarModal');
        const remindersModal = document.getElementById('modRemindersModal');
        const inboxModal = document.getElementById('modInboxModal');

        if (calendarModal && calendarModal.classList.contains('opacity-100')) populateCalendarDropdown();
        if (remindersModal && remindersModal.classList.contains('opacity-100')) populateActiveRemindersPanel();
        if (inboxModal && inboxModal.classList.contains('opacity-100')) populateInboxLogsPanel();
    });
}

// ======================================================
// TASK ITEM INTERACTIVE ACTIONS
// ======================================================
function attachDynamicItemListeners() {
    document.querySelectorAll('.task-toggle-checkbox').forEach(box => {
        box.onchange = async (e) => {
            const id = e.target.getAttribute('data-id');
            const checked = e.target.checked;
            try {
                await updateDoc(doc(db, "tasks", id), {
                    completed: checked
                });

                const task = cachedTasksArray.find(item => item.id === id);
                if (task) {
                    task.completed = checked;
                }

                refreshTaskDisplay();
            } catch (err) {
                console.error(err);
            }
        };
    });

    document.querySelectorAll('.edit-task-btn').forEach(btn => {
        btn.onclick = (e) => {
            const id = e.target.getAttribute('data-id');
            const task = cachedTasksArray.find(item => item.id === id);
            if (!task) return;
            openTaskModalForEdit(task);
        };
    });

    document.querySelectorAll('.delete-task-btn').forEach(btn => {
        btn.onclick = async (e) => {
            const id = e.target.getAttribute('data-id');
            try {
                await deleteDoc(doc(db, "tasks", id));
                cachedTasksArray = cachedTasksArray.filter(item => item.id !== id);
                refreshTaskDisplay();
            } catch (err) {
                console.error(err);
            }
        };
    });
}

// ======================================================
// OTP INPUTS
// ======================================================
function setupOtpInputsBehavior() {
    const boxes = document.querySelectorAll('.otp-box');
    const verifyBtn = document.getElementById('verifyOtpBtn');

    if (boxes.length === 0) return;

    boxes.forEach((box, idx) => {
        box.oninput = () => {
            box.value = box.value.replace(/[^0-9]/g, '');
            if (box.value && idx < boxes.length - 1) {
                boxes[idx + 1].focus();
            }
        };
    });

    if (verifyBtn) {
        verifyBtn.onclick = async () => {
            let enteredOtp = "";
            boxes.forEach(box => { enteredOtp += box.value; });

            if (enteredOtp !== String(systemGeneratedOtp)) {
                alert("Invalid OTP code.");
                return;
            }

            try {
                if (pendingRegistrationData.mode === "create") {
                    await createUserWithEmailAndPassword(
                        auth,
                        pendingRegistrationData.email,
                        pendingRegistrationData.password
                    );
                } else {
                    await signInWithEmailAndPassword(
                        auth,
                        pendingRegistrationData.email,
                        pendingRegistrationData.password
                    );
                }

                alert("Authentication successful.");
                safeRedirect("dashboard.html");
            } catch (err) {
                alert(err.message);
            }
        };
    }
}

// ======================================================
// PASSWORD VALIDATION
// ======================================================
function validatePassword(password) {
    const hasLength = password.length >= 6;
    const hasUppercase = /[A-Z]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    return { hasLength, hasUppercase, hasSpecial };
}

// ======================================================
// EMAIL OTP
// ======================================================
async function sendOtpViaEmail(recipientEmail, otpCode) {
    const SERVICE_ID = "service_u4kqk8s";
    const TEMPLATE_ID = "template_enyyyzs";

    const templateParams = {
        to_email: recipientEmail,
        otp_code: otpCode
    };

    if (typeof emailjs === 'undefined') {
        throw new Error("EmailJS SDK missing.");
    }

    await emailjs.send(SERVICE_ID, TEMPLATE_ID, templateParams);
    alert(`OTP sent to ${recipientEmail}`);

    const otpModal = document.getElementById('otpModal');
    if (otpModal) {
        otpModal.classList.remove('hidden');
    }
}

// ======================================================
// HANDLE AUTH
// ======================================================
async function handleAuth(mode) {
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
        alert("Fill all fields.");
        return;
    }

    const { hasLength, hasUppercase, hasSpecial } = validatePassword(password);

    if (!hasLength || !hasUppercase || !hasSpecial) {
        alert("Password needs:\n- 6 chars\n- uppercase\n- special char");
        return;
    }

    systemGeneratedOtp = Math.floor(100000 + Math.random() * 900000);
    pendingRegistrationData = { email, password, mode };

    try {
        await sendOtpViaEmail(email, systemGeneratedOtp);
    } catch (err) {
        alert(err.message);
    }
}

// ======================================================
// LOGIN LISTENERS
// ======================================================
function setupLoginInterfaceListeners() {
    const createBtn = document.getElementById('createAccBtn');
    const loginBtn = document.getElementById('loginBtn');

    if (createBtn) {
        createBtn.onclick = (e) => {
            e.preventDefault();
            handleAuth("create");
        };
    }

    if (loginBtn) {
        loginBtn.onclick = (e) => {
            e.preventDefault();
            handleAuth("login");
        };
    }
}