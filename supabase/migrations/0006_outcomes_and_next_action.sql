-- =====================================================================
-- vexy-mailer :: dva chybějící výsledky hovoru
-- =====================================================================
-- "Není ICP" a "Již zákazník" jsou v outboundu běžné závěry, které se
-- nedají schovat pod "nemá zájem": první říká, že firma do výběru vůbec
-- neměla patřit, druhý že už ji máme. Obojí uzavírá workflow, ale znamená
-- pro další výběr firem něco jiného.
--
-- Aditivní: rozšiřuje se jen výčet povolených hodnot.
-- =====================================================================

alter table call_activities drop constraint if exists call_activities_outcome_check;
alter table call_activities add constraint call_activities_outcome_check
  check (outcome in ('no_answer', 'busy', 'wrong_number', 'gatekeeper',
                     'callback', 'not_interested', 'no_budget', 'not_decision_maker',
                     'send_info', 'meeting_booked', 'won', 'do_not_call',
                     'not_icp', 'existing_customer'));

-- Index pod "další krok": fronta i seznam firem se ptají na splatnost
-- napříč stavy, ne jen u callbacků.
create index if not exists campaign_contacts_next_action_idx
  on campaign_contacts (next_call_at)
  where call_status in ('new', 'in_progress', 'callback');

-- ---------------------------------------------------------------------
-- Pozice kontaktu
-- ---------------------------------------------------------------------
-- "Správný člověk" je půlka úspěchu cold callu. Caller potřebuje před
-- vytočením vidět, jestli mluví s jednatelem nebo s asistentkou - jinak
-- outcome "není rozhodovatel" vzniká zbytečně.
alter table contacts add column if not exists position text;
