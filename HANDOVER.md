# PeopleFlow HR System — Complete Handover Document

## Project Overview
Single-file HTML HR system for PCG Technologies (PCG Global).
48 employees, 5 departments, Supabase backend, deployed on Digital Ocean.

---

## Live URLs
- **Digital Ocean:** http://168.144.67.88
- **GitHub:** https://pcg-global.github.io/peopleflow/
- **GitHub Repo:** https://github.com/PCG-Global/peopleflow

---

## Credentials

### Supabase
- **URL:** https://prcgdpvogoqtgfpprktu.supabase.co
- **Publishable Key:** sb_publishable_qPgML8EuJU04mcKGbWTkLA_7b4iwLZX
- **Dashboard:** https://supabase.com/dashboard/project/prcgdpvogoqtgfpprktu

### Digital Ocean
- **Droplet IP:** 168.144.67.88
- **Region:** Bangalore (BLR1)
- **OS:** Ubuntu 22.04 LTS
- **SSH:** ssh root@168.144.67.88
- **File location:** /var/www/peopleflow/index.html

### EmailJS
- **Public Key:** x-SDmI21gSfrVKZeD
- **Service ID:** service_srwzblo
- **Template ID:** template_bca9sch

### Google Apps Script (Attendance Sync - legacy)
- **URL:** https://script.google.com/macros/s/AKfycbxYwHPBp2uQuDTA1Fb_mOdVCmM2HjqbdX72OAAideWeDxZ5onxqZAW3EwC56RT9rxc/exec

### Admin Login
- **Sudheer Kumar (Admin):** PCG0101 / Emp@5678
- **Default password all employees:** Emp@5678

---

## Supabase Database Tables

### 1. attendance
```sql
emp_id, emp_name, date, in_time, out_time, location, 
in_address, out_address, status, dept, source, 
auto_checkout, regularized, created_at, updated_at
UNIQUE: (emp_id, date)
```

### 2. leaves
```sql
id (text PK), emp_id, emp_name, type, from_date, to_date,
days, session, reason, handover, status, applied_on,
created_at, updated_at
```

### 3. leave_balances
```sql
emp_id (PK), casual, sick, wfh, cl_month, sl_year, 
wfh_month, updated_at
```
- All 48 employees pre-populated with HR file values

### 4. employee_profiles
```sql
emp_id (PK), dob, blood, phone, address, emg_name, 
emg_phone, aadhaar, edu_highest, edu_field, edu_univ,
edu_year, edu_pct, cert1, cert1_org, cert2, cert2_org,
educations (jsonb), bank_name, bank, acc, ifsc, acctype,
branch, pan, pf, designation, dept, location, ctc, 
manager, skills, password_hash, updated_at
```

### 5. regularize_requests
```sql
id (text PK), emp_id, emp_name, dept, date, in_time,
out_time, location, reason, status, submitted_at, updated_at
```

### RLS Policies
All tables have open RLS policies (allow all) since this is internal app.

---

## Employee Data

### 5 Departments
1. Litigation
2. Compliance  
3. Tax & Regulatory
4. Accounts
5. Audit & Assurance

### 9 Managers (DEPT_MANAGER_IDS)
- PCG0119 — Mansabdar Aditya (Litigation)
- PCG0074 — Ramakrishnan Suresh (Litigation)
- PCG0146 — Kruthika Meda (Litigation)
- PCG0087 — Prajwal M P (Litigation)
- PCG0102 — Pushpan Gidra (Litigation)
- PCG0100 — Pravallika Koppaka (Compliance)
- PCG0091 — Ganesh Irugu (Litigation)
- PCG0101 — Sudheer Kumar (Compliance) ← ADMIN
- PCG0082 — Naveen K M (Audit & Assurance)

### Total Employees: 48
All defined via mkEmp() function in the HTML file.

---

## Leave Rules
| Type | Allowance | Reset | Expires |
|------|-----------|-------|---------|
| Casual | 1/month | Monthly | No (carry forward) |
| Sick | 3/year | Yearly | No (carry forward) |
| WFH Female | 1/month | Monthly | Yes (expires) |
| WFH Permission | No limit | N/A | N/A |

All leave types = PAID (no salary deduction)

---

## Access Control
| Feature | Who can access |
|---------|---------------|
| All Employees module | Sudheer only |
| HR Reports | Sudheer only |
| Payroll | Sudheer only |
| Department View | Sudheer only |
| Leave Approvals | Managers + Sudheer |
| Reports (team) | Managers |
| Check In/Out admin | Sudheer only |
| Regularize approvals | Sudheer only |

---

## Two-Stage Leave Approval
1. Employee applies → status: `pending_manager`
2. Manager approves → status: `pending_sudheer`
3. Sudheer approves → status: `approved` + balance deducted
- Managers' own leaves go directly to `pending_sudheer`

---

## Key Functions in Code

### Authentication
- `doLogin()` — checks Supabase password then local
- `initApp()` — runs after login, loads all data
- `doLogout()` — clears session

### Attendance
- `handleCheckinClick()` — check in
- `handleCheckoutClick()` — check out
- `syncAttendance(action, time)` — saves to Supabase
- `fetchAttendanceFromSupabase(date)` — loads for managers
- `restoreCheckinSession()` — restores from localStorage or Supabase
- `restoreCheckinFromSupabase()` — cross-device session restore
- `renderAllAttendanceTable()` — Sudheer's full attendance table

### Leave System
- `submitLeave()` — employee applies leave
- `approveLeave(empId, lid)` — manager/Sudheer approves
- `rejectLeave(empId, lid)` — rejects leave
- `renderLeaveApprovals()` — fetches from Supabase + renders
- `syncLeaveToSupabase(leave)` — saves leave to Supabase
- `fetchAllLeavesFromSupabase()` — loads all leaves

### Balance System
- `fetchBalanceFromSupabase(empId)` — loads balance
- `syncBalanceToSupabase(u)` — saves balance
- LEAVE_BALANCES constant — HR file values (starting point)

### Profile
- `syncProfileToSupabase(u)` — saves profile
- `fetchProfileFromSupabase(empId)` — loads profile

### Regularize
- `submitRegularize()` — employee requests regularization
- `approveRegularize(reqId)` — Sudheer approves
- `rejectRegularize(reqId)` — Sudheer rejects
- `syncRegularizeToSupabase(req)` — saves to Supabase
- `fetchRegularizeFromSupabase()` — loads for Sudheer

### Supabase Connection
- `getSB()` — get Supabase client
- `getSBAsync()` — get with retry (waits up to 5s)

---

## Auto-Refresh (every 30s for managers/Sudheer)
- Fetches attendance from Supabase
- Fetches leave approvals from Supabase
- Updates badges and tables
- Refreshes active pages

---

## App Version
- Current: `pf_v4.1`
- Changing version clears all localStorage cache

---

## To Deploy Updates
### GitHub Pages:
1. Upload index.html to github.com/PCG-Global/peopleflow
2. Auto-deploys in 2-3 minutes

### Digital Ocean:
```bash
scp index.html root@168.144.67.88:/var/www/peopleflow/index.html
ssh root@168.144.67.88
systemctl restart nginx
```

---

## Known Limitations
- Photos stored in localStorage only (not cross-device)
- Check-in session localStorage + Supabase (cross-device works)
- All data in Supabase is permanent

---

## Pending Items
- Set up subdomain (e.g. hr.pcg.net.in) pointing to 168.144.67.88
- Add SSL certificate (HTTPS) via Let's Encrypt
- Configure Nginx for subdomain

## SSL Setup (when subdomain is ready)
```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d hr.pcg.net.in
```

---

## File Structure
```
/var/www/peopleflow/
  index.html  ← entire application (single file, ~430KB)
```

---

## Tech Stack
- Frontend: Vanilla HTML/CSS/JS (single file)
- Backend: Supabase (PostgreSQL)
- Hosting: Digital Ocean Nginx + GitHub Pages
- Email: EmailJS
- Fonts: Google Fonts (Syne + DM Sans)
- Supabase JS: CDN v2
